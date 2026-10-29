import type { AirtableClient, AirtableRecord } from './airtable'
import { EnrollmentAuthorizationError, EnrollmentTokenStore } from './enrollment'
import type { AssessmentAuditStore, AuditEventInput } from './audit'

export interface AssessmentData {
  id: string
  title: string
  instructions: string
  durationMinutes: number
  questions: Array<{ id: string; prompt: string; options: AssessmentOption[] }>
  recordId: string
}

export interface AssessmentOption {
  id: string
  text: string
}

export interface AttemptData {
  attemptId: string
  assessmentId: string
  recordId: string
  status: 'in_progress' | 'submitted'
}

export class AssessmentService {
  private readonly submissionLocks = new Map<
    string,
    Promise<{ submissionId: string; submittedAt: string; status: 'accepted'; message: string }>
  >()

  constructor(
    private readonly airtable: AirtableClient,
    private readonly tables: {
      assessments: string
      questions: string
      attempts: string
    },
    private readonly enrollment: EnrollmentTokenStore = new EnrollmentTokenStore(false),
    private readonly auditStore?: AssessmentAuditStore
  ) {}

  issueEnrollmentToken(assessmentId: string): { token: string; expiresAt: string } {
    if (!isBoundedIdentifier(assessmentId)) throw new ValidationError('Assessment ID is invalid.')
    return this.enrollment.issue(assessmentId)
  }

  async getPublishedAssessment(id: string): Promise<AssessmentData> {
    if (!isBoundedIdentifier(id)) throw new ValidationError('Assessment ID is invalid.')
    const records = await this.airtable.list(
      this.tables.assessments,
      `{AssessmentId} = '${escapeFormula(id)}'`
    )
    const record = records[0]
    if (!record || record.fields.IsPublished !== true)
      throw new NotFoundError('Assessment not found.')
    const questions = await this.airtable.list(
      this.tables.questions,
      `{AssessmentId} = '${escapeFormula(id)}'`
    )
    const activeQuestions = questions
      .filter((question) => question.fields.IsActive === true)
      .sort((a, b) => numberField(a, 'Order') - numberField(b, 'Order'))
      .map(mapQuestion)
    if (activeQuestions.length === 0) {
      throw new ValidationError('Published assessment has no active questions.')
    }
    if (new Set(activeQuestions.map((question) => question.id)).size !== activeQuestions.length) {
      throw new ValidationError('Assessment question IDs must be unique.')
    }
    return {
      id: stringField(record, 'AssessmentId'),
      title: stringField(record, 'Title'),
      instructions: stringField(record, 'Instructions'),
      durationMinutes: boundedDuration(record.fields.DurationMinutes),
      recordId: record.id,
      questions: activeQuestions
    }
  }

  async createAttempt(
    assessmentId: string,
    participantDisplayName: string,
    enrollmentToken?: string,
    participantEmail?: string
  ): Promise<AttemptData> {
    if (!isBoundedIdentifier(assessmentId)) throw new ValidationError('Assessment ID is invalid.')
    const assessment = await this.getPublishedAssessment(assessmentId)
    if (
      typeof participantDisplayName !== 'string' ||
      !participantDisplayName.trim() ||
      participantDisplayName.length > 100
    ) {
      throw new ValidationError('Participant display name is invalid.')
    }
    const attemptId = crypto.randomUUID()
    if (!enrollmentToken && !participantEmail) throw new EnrollmentAuthorizationError()
    if (enrollmentToken) this.enrollment.bindAttempt(enrollmentToken, assessment.id, attemptId)
    const record = await this.airtable.create(this.tables.attempts, {
      AttemptId: attemptId,
      AssessmentId: assessment.id,
      ParticipantDisplayName: participantDisplayName.trim(),
      ...(participantEmail ? { ParticipantEmail: participantEmail } : {}),
      StartedAt: new Date().toISOString(),
      Status: 'in_progress',
      AnswersJSON: '[]'
    })
    return { attemptId, assessmentId: assessment.id, recordId: record.id, status: 'in_progress' }
  }

  async submit(
    attemptId: string,
    assessmentId: string,
    answers: unknown,
    enrollmentToken?: string,
    trustedAuthorization = false
  ): Promise<{ submissionId: string; submittedAt: string; status: 'accepted'; message: string }> {
    if (!isBoundedIdentifier(attemptId) || !isBoundedIdentifier(assessmentId)) {
      throw new ValidationError('Attempt or assessment ID is invalid.')
    }
    if (!trustedAuthorization) this.authorizeAttempt(enrollmentToken, assessmentId, attemptId)
    const pending = this.submissionLocks.get(attemptId)
    if (pending) return pending
    const operation = this.submitOnce(attemptId, assessmentId, answers)
    this.submissionLocks.set(attemptId, operation)
    try {
      return await operation
    } finally {
      if (this.submissionLocks.get(attemptId) === operation) this.submissionLocks.delete(attemptId)
    }
  }

  private async submitOnce(
    attemptId: string,
    assessmentId: string,
    answers: unknown
  ): Promise<{ submissionId: string; submittedAt: string; status: 'accepted'; message: string }> {
    if (!Array.isArray(answers) || answers.length > 100) {
      throw new ValidationError('Answers must be a bounded array.')
    }
    const attempts = await this.airtable.list(
      this.tables.attempts,
      `{AttemptId} = '${escapeFormula(attemptId)}'`
    )
    const attempt = attempts[0]
    if (!attempt || stringField(attempt, 'AssessmentId') !== assessmentId) {
      throw new NotFoundError('Attempt not found.')
    }
    if (stringField(attempt, 'Status') === 'submitted') {
      const submissionId = stringField(attempt, 'SubmissionId')
      return {
        submissionId,
        submittedAt: stringField(attempt, 'SubmittedAt'),
        status: 'accepted',
        message: 'Submission was already accepted.'
      }
    }
    const assessment = await this.getPublishedAssessment(assessmentId)
    const startedAt = Date.parse(stringField(attempt, 'StartedAt'))
    if (!Number.isFinite(startedAt)) {
      throw new ValidationError('Attempt start time is invalid.')
    }
    if (Date.now() >= startedAt + assessment.durationMinutes * 60_000) {
      await this.airtable.update(this.tables.attempts, attempt.id, { Status: 'expired' })
      throw new ValidationError('Assessment deadline has expired.')
    }
    const validQuestions = new Map(assessment.questions.map((question) => [question.id, question]))
    const normalized = answers.map((answer) => {
      if (!isAnswer(answer)) throw new ValidationError('Invalid answer format.')
      const question = validQuestions.get(answer.questionId)
      if (
        !question ||
        !Number.isInteger(answer.optionIndex) ||
        answer.optionIndex < 0 ||
        answer.optionIndex >= question.options.length
      ) {
        throw new ValidationError('Answer contains an invalid question or option.')
      }
      return { questionId: answer.questionId, optionIndex: answer.optionIndex }
    })
    const submittedAt = new Date().toISOString()
    const submissionId = crypto.randomUUID()
    await this.airtable.update(this.tables.attempts, attempt.id, {
      Status: 'submitted',
      SubmittedAt: submittedAt,
      AnswersJSON: JSON.stringify(normalized),
      SubmissionId: submissionId
    })
    return {
      submissionId,
      submittedAt,
      status: 'accepted',
      message: 'Remote submission persisted by the assessment backend.'
    }
  }

  async getSubmission(
    attemptId: string,
    assessmentId: string,
    enrollmentToken?: string,
    trustedAuthorization = false
  ): Promise<Record<string, string>> {
    if (!isBoundedIdentifier(attemptId)) throw new ValidationError('Attempt ID is invalid.')
    if (!isBoundedIdentifier(assessmentId)) throw new ValidationError('Assessment ID is invalid.')
    if (!trustedAuthorization) this.authorizeAttempt(enrollmentToken, assessmentId, attemptId)
    const records = await this.airtable.list(
      this.tables.attempts,
      `{AttemptId} = '${escapeFormula(attemptId)}'`
    )
    const attempt = records[0]
    if (!attempt) throw new NotFoundError('Attempt not found.')
    return {
      attemptId,
      status: stringField(attempt, 'Status'),
      submissionId: optionalStringField(attempt, 'SubmissionId'),
      submittedAt: optionalStringField(attempt, 'SubmittedAt')
    }
  }

  async recordActivityEvent(
    attemptId: string,
    assessmentId: string,
    event: AuditEventInput
  ): Promise<void> {
    if (!this.auditStore) throw new Error('Audit event storage is unavailable.')
    if (!isBoundedIdentifier(attemptId)) throw new ValidationError('Attempt ID is invalid.')
    if (!isBoundedIdentifier(assessmentId)) throw new ValidationError('Assessment ID is invalid.')
    const records = await this.airtable.list(
      this.tables.attempts,
      `{AttemptId} = '${escapeFormula(attemptId)}'`
    )
    const attempt = records[0]
    if (!attempt || stringField(attempt, 'AssessmentId') !== assessmentId) {
      throw new NotFoundError('Attempt not found.')
    }
    if (stringField(attempt, 'Status') !== 'in_progress') {
      throw new ValidationError('Assessment activity is no longer active.')
    }
    const assessment = await this.getPublishedAssessment(assessmentId)
    const startedAt = Date.parse(stringField(attempt, 'StartedAt'))
    if (
      !Number.isFinite(startedAt) ||
      Date.now() >= startedAt + assessment.durationMinutes * 60_000
    ) {
      throw new ValidationError('Assessment activity is no longer active.')
    }
    this.auditStore.append(assessmentId, attemptId, event)
  }

  private authorizeAttempt(
    enrollmentToken: string | undefined,
    assessmentId: string,
    attemptId: string
  ): void {
    if (!enrollmentToken) throw new EnrollmentAuthorizationError()
    this.enrollment.authorize(enrollmentToken, assessmentId, attemptId)
  }
}

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export function parseQuestionOptions(raw: unknown): AssessmentOption[] {
  let parsed: unknown
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw new ValidationError('Question OptionsJSON is malformed JSON.')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        typeof (item as Record<string, unknown>).id !== 'string' ||
        !(item as Record<string, string>).id.trim() ||
        typeof (item as Record<string, unknown>).text !== 'string' ||
        !(item as Record<string, string>).text.trim()
    )
  ) {
    throw new ValidationError(
      'Question OptionsJSON must be an array of exactly four options with non-empty id and text strings.'
    )
  }
  const options = parsed.map((item) => {
    const option = item as { id: string; text: string }
    return { id: option.id.trim(), text: option.text.trim() }
  })
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new ValidationError('Question OptionsJSON contains duplicate option IDs.')
  }
  return options
}

function mapQuestion(record: AirtableRecord): {
  id: string
  prompt: string
  options: AssessmentOption[]
} {
  return {
    id: stringField(record, 'QuestionId'),
    prompt: stringField(record, 'Prompt'),
    options: parseQuestionOptions(record.fields.OptionsJSON)
  }
}

function stringField(record: AirtableRecord, field: string): string {
  const value = record.fields[field]
  if (typeof value !== 'string' || !value.trim())
    throw new ValidationError(`Missing Airtable field: ${field}.`)
  return value.trim()
}

function optionalStringField(record: AirtableRecord, field: string): string {
  const value = record.fields[field]
  return typeof value === 'string' ? value : ''
}

function numberField(record: AirtableRecord, field: string): number {
  const value = record.fields[field]
  return typeof value === 'number' ? value : Number(value)
}

function boundedDuration(value: unknown): number {
  const duration = Number(value)
  if (!Number.isInteger(duration) || duration < 1 || duration > 1_440) {
    throw new ValidationError('Assessment duration is invalid.')
  }
  return duration
}

function isAnswer(value: unknown): value is { questionId: string; optionIndex: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).questionId === 'string' &&
    typeof (value as Record<string, unknown>).optionIndex === 'number'
  )
}

function escapeFormula(value: string): string {
  return value.replace(/'/g, "\\'")
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
