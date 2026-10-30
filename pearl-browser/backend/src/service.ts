import type { AirtableClient, AirtableRecord } from './airtable'
import { EnrollmentAuthorizationError, EnrollmentTokenStore } from './enrollment'
import type { AssessmentAuditEvent, AssessmentAuditStore, AuditEventInput } from './audit'
import type {
  AdminAssessmentDraft,
  AdminConsoleAssessment,
  AdminConsoleAttempt,
  AdminConsoleData,
  AdminConsoleQuestion,
  AdminConsoleQuestionValidationError
} from '../../src/shared/admin'
import type { AssessmentDraftRegistry } from './questionDraftRegistry'

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
  startedAt: string
  deadline: string
}

export class AssessmentService {
  private readonly participantAttemptCreations = new Set<string>()
  private readonly submissionLocks = new Map<
    string,
    Promise<{ submissionId: string; submittedAt: string; status: 'accepted'; message: string }>
  >()
  private readonly draftCreations = new Set<string>()

  constructor(
    private readonly airtable: AirtableClient,
    private readonly tables: {
      assessments: string
      questions: string
      attempts: string
    },
    private readonly enrollment: EnrollmentTokenStore = new EnrollmentTokenStore(false),
    private readonly auditStore?: AssessmentAuditStore,
    private readonly draftRegistry?: AssessmentDraftRegistry
  ) {}

  hasActivityLog(): boolean {
    return this.auditStore !== undefined
  }

  async saveAssessmentDraft(input: unknown): Promise<void> {
    validateAssessmentDraft(input)
    const draft = input
    if (!this.draftRegistry) {
      throw new ValidationError('Assessment draft persistence is not configured.')
    }
    if (this.draftCreations.has(draft.id)) {
      throw new ValidationError('This assessment draft is already being saved.')
    }
    this.draftCreations.add(draft.id)
    try {
      const assessments = await this.airtable.list(
        this.tables.assessments,
        `{AssessmentId} = '${escapeFormula(draft.id)}'`
      )
      if (assessments.some((record) => optionalStringField(record, 'AssessmentId') === draft.id)) {
        throw new ValidationError('This assessment ID already exists. Choose a new ID.')
      }
      const existingQuestions = await this.airtable.list(
        this.tables.questions,
        `{AssessmentId} = '${escapeFormula(draft.id)}'`
      )
      if (existingQuestions.length > 0) {
        throw new ValidationError('Questions already exist for this assessment ID.')
      }
      await this.draftRegistry.register(draft.id)
      await this.airtable.create(this.tables.assessments, {
        AssessmentId: draft.id,
        Title: draft.title.trim(),
        Instructions: draft.instructions.trim(),
        DurationMinutes: draft.durationMinutes,
        IsPublished: false
      })
      let savedQuestions = 0
      try {
        for (const question of draft.questions) {
          await this.airtable.create(this.tables.questions, {
            QuestionId: question.id,
            AssessmentId: draft.id,
            Prompt: question.prompt.trim(),
            OptionsJSON: JSON.stringify(
              question.options.map((option) => ({
                id: option.id.trim(),
                text: option.text.trim()
              }))
            ),
            Order: question.order,
            IsActive: true,
            CorrectOptionId: question.correctOptionId
          })
          savedQuestions += 1
        }
      } catch (error) {
        throw new AssessmentDraftWriteError(draft.id, savedQuestions, error)
      }
    } finally {
      this.draftCreations.delete(draft.id)
    }
  }

  async publishAssessmentDraft(assessmentId: string): Promise<void> {
    if (!isBoundedIdentifier(assessmentId)) throw new ValidationError('Assessment ID is invalid.')
    if (!this.draftRegistry?.has(assessmentId)) {
      throw new ValidationError(
        'Only a draft created by the AI Question Generator can be published.'
      )
    }
    const assessments = await this.airtable.list(
      this.tables.assessments,
      `{AssessmentId} = '${escapeFormula(assessmentId)}'`
    )
    const assessment = assessments.find(
      (record) => optionalStringField(record, 'AssessmentId') === assessmentId
    )
    if (!assessment) throw new NotFoundError('Assessment draft not found.')
    if (assessment.fields.IsPublished === true) {
      throw new ValidationError('This assessment is already published.')
    }
    const attempts = await this.airtable.list(
      this.tables.attempts,
      `{AssessmentId} = '${escapeFormula(assessmentId)}'`
    )
    if (attempts.length > 0) {
      throw new ValidationError(
        'An assessment with attempt records cannot be published as a draft.'
      )
    }
    boundedDuration(assessment.fields.DurationMinutes)
    stringField(assessment, 'Title')
    stringField(assessment, 'Instructions')
    const questionRecords = await this.airtable.list(
      this.tables.questions,
      `{AssessmentId} = '${escapeFormula(assessmentId)}'`
    )
    const activeQuestions = questionRecords.filter((record) => record.fields.IsActive === true)
    if (activeQuestions.length === 0 || activeQuestions.length > 20) {
      throw new ValidationError('The assessment must contain between 1 and 20 active questions.')
    }
    const ids = new Set<string>()
    for (const [index, question] of activeQuestions
      .sort((a, b) => numberField(a, 'Order') - numberField(b, 'Order'))
      .entries()) {
      const id = stringField(question, 'QuestionId')
      if (ids.has(id)) throw new ValidationError('Assessment question IDs must be unique.')
      ids.add(id)
      const options = parseQuestionOptions(question.fields.OptionsJSON)
      const answerId = stringField(question, 'CorrectOptionId')
      if (!options.some((option) => option.id === answerId)) {
        throw new ValidationError('An active question has an invalid answer key.')
      }
      stringField(question, 'Prompt')
      if (numberField(question, 'Order') !== index + 1) {
        throw new ValidationError('Question order must be complete and sequential.')
      }
    }
    await this.airtable.update(this.tables.assessments, assessment.id, { IsPublished: true })
  }

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

  async getAdminConsoleData(): Promise<AdminConsoleData> {
    const [assessmentRecords, questionRecords, attemptRecords] = await Promise.all([
      this.airtable.list(this.tables.assessments),
      this.airtable.list(this.tables.questions),
      this.airtable.list(this.tables.attempts)
    ])
    const questionValidationErrors: AdminConsoleQuestionValidationError[] = []
    const questions: AdminConsoleQuestion[] = questionRecords.map((record) => {
      const question = {
        recordId: record.id,
        id: optionalStringField(record, 'QuestionId'),
        assessmentId: optionalStringField(record, 'AssessmentId'),
        prompt: optionalStringField(record, 'Prompt'),
        order: optionalNumberField(record, 'Order'),
        isActive: record.fields.IsActive === true
      }
      try {
        return { ...question, options: parseQuestionOptions(record.fields.OptionsJSON) }
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error
        const validationError = error.message
        questionValidationErrors.push({
          recordId: question.recordId,
          questionId: question.id,
          assessmentId: question.assessmentId,
          message: validationError
        })
        return { ...question, options: [], validationError }
      }
    })
    const activeQuestionIdsByAssessment = new Map<string, Set<string>>()
    for (const question of questions) {
      if (!question.isActive || question.validationError || !question.id || !question.assessmentId) {
        continue
      }
      const questionIds = activeQuestionIdsByAssessment.get(question.assessmentId) ?? new Set()
      questionIds.add(question.id)
      activeQuestionIdsByAssessment.set(question.assessmentId, questionIds)
    }
    const attempts: AdminConsoleAttempt[] = attemptRecords.map((record) => {
      const assessmentId = optionalStringField(record, 'AssessmentId')
      const startedAt = optionalStringField(record, 'StartedAt')
      const assessment = assessmentRecords.find(
        (candidate) => optionalStringField(candidate, 'AssessmentId') === assessmentId
      )
      const durationMinutes = assessment ? optionalNumberField(assessment, 'DurationMinutes') : null
      const startedAtMs = Date.parse(startedAt)
      const deadline =
        Number.isFinite(startedAtMs) && durationMinutes !== null
          ? new Date(startedAtMs + durationMinutes * 60_000).toISOString()
          : ''
      const totalQuestionCount = activeQuestionIdsByAssessment.get(assessmentId)?.size ?? 0
      return {
        id: optionalStringField(record, 'AttemptId'),
        assessmentId,
        participantDisplayName: optionalStringField(record, 'ParticipantDisplayName'),
        participantEmail: optionalStringField(record, 'ParticipantEmail'),
        status: optionalStringField(record, 'Status'),
        startedAt,
        deadline,
        answeredQuestionCount:
          optionalStringField(record, 'Status') === 'in_progress'
            ? null
            : parseAnsweredQuestionCount(
                record.fields.AnswersJSON,
                activeQuestionIdsByAssessment.get(assessmentId) ?? new Set()
              ),
        totalQuestionCount,
        cameraStatus: '',
        submittedAt: optionalStringField(record, 'SubmittedAt'),
        submissionId: optionalStringField(record, 'SubmissionId')
      }
    })
    const assessments: AdminConsoleAssessment[] = assessmentRecords.map((record) => {
      const id = optionalStringField(record, 'AssessmentId')
      return {
        id,
        title: optionalStringField(record, 'Title'),
        durationMinutes: optionalNumberField(record, 'DurationMinutes'),
        isPublished: record.fields.IsPublished === true,
        questionCount: questions.filter((question) => question.assessmentId === id).length,
        attemptCount: attempts.filter((attempt) => attempt.assessmentId === id).length
      }
    })
    const events = (this.auditStore?.listAll() ?? []).map((event) => ({
      id: event.id,
      assessmentId: event.assessmentId,
      attemptId: event.attemptId,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.hostname ? { hostname: event.hostname } : {}),
      ...(event.fromHostname ? { fromHostname: event.fromHostname } : {}),
      ...(event.observationCount !== undefined ? { observationCount: event.observationCount } : {}),
      ...(event.observationDurationMs !== undefined
        ? { observationDurationMs: event.observationDurationMs }
        : {}),
      ...(event.confidence !== undefined ? { confidence: event.confidence } : {})
    }))
    const latestEventByAttempt = new Map<string, AssessmentAuditEvent>()
    const latestCameraEventByAttempt = new Map<string, AssessmentAuditEvent>()
    for (const event of events) {
      const previous = latestEventByAttempt.get(event.attemptId)
      if (!previous || Date.parse(event.occurredAt) > Date.parse(previous.occurredAt)) {
        latestEventByAttempt.set(event.attemptId, event)
      }
      if (
        [
          'camera_started',
          'camera_stopped',
          'camera_permission_denied',
          'camera_unavailable',
          'camera_disconnected'
        ].includes(event.type)
      ) {
        const previousCameraEvent = latestCameraEventByAttempt.get(event.attemptId)
        if (
          !previousCameraEvent ||
          Date.parse(event.occurredAt) > Date.parse(previousCameraEvent.occurredAt)
        ) {
          latestCameraEventByAttempt.set(event.attemptId, event)
        }
      }
    }
    for (const attempt of attempts) {
      const latestActivity = latestEventByAttempt.get(attempt.id)
      if (latestActivity) attempt.latestActivity = latestActivity
      const cameraEvent = latestCameraEventByAttempt.get(attempt.id)
      if (cameraEvent) {
        attempt.cameraStatus =
          {
            camera_started: 'Started',
            camera_stopped: 'Stopped',
            camera_permission_denied: 'Permission denied',
            camera_unavailable: 'Unavailable',
            camera_disconnected: 'Disconnected'
          }[cameraEvent.type] ?? 'Not reported'
      } else {
        attempt.cameraStatus = ''
      }
    }
    const candidateEmails = new Set(
      attempts.map((attempt) => attempt.participantEmail.trim().toLowerCase()).filter(Boolean)
    )
    const now = Date.now()
    return {
      generatedAt: new Date().toISOString(),
      metrics: {
        totalAssessments: assessments.length,
        publishedAssessments: assessments.filter((assessment) => assessment.isPublished).length,
        totalCandidates: candidateEmails.size,
        activeAttempts: attempts.filter(
          (attempt) =>
            attempt.status === 'in_progress' &&
            Number.isFinite(Date.parse(attempt.deadline)) &&
            Date.parse(attempt.deadline) > now
        ).length,
        submittedAttempts: attempts.filter((attempt) => attempt.status === 'submitted').length,
        expiredAttempts: attempts.filter((attempt) => attempt.status === 'expired').length,
        failedAttempts: attempts.filter((attempt) => attempt.status === 'failed').length
      },
      assessments,
      questions,
      questionValidationErrors,
      attempts,
      events,
      activityLogAvailable: this.hasActivityLog()
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
    const participantKey = participantEmail
      ? `${assessmentId}:${participantEmail.trim().toLowerCase()}`
      : undefined
    if (participantKey && this.participantAttemptCreations.has(participantKey)) {
      throw new ValidationError('An assessment attempt is already being created for this account.')
    }
    if (participantKey) this.participantAttemptCreations.add(participantKey)
    try {
      if (participantEmail) {
        const existingAttempts = await this.airtable.list(
          this.tables.attempts,
          `AND({ParticipantEmail} = '${escapeFormula(participantEmail)}', {AssessmentId} = '${escapeFormula(assessmentId)}', {Status} = 'in_progress')`
        )
        const now = Date.now()
        for (const existing of existingAttempts) {
          if (
            stringField(existing, 'ParticipantEmail').trim().toLowerCase() !==
              participantEmail.trim().toLowerCase() ||
            stringField(existing, 'AssessmentId') !== assessmentId ||
            stringField(existing, 'Status') !== 'in_progress'
          ) {
            continue
          }
          const startedAt = Date.parse(stringField(existing, 'StartedAt'))
          if (Number.isFinite(startedAt) && now < startedAt + assessment.durationMinutes * 60_000) {
            throw new ValidationError(
              'An active assessment attempt already exists for this account.'
            )
          }
          await this.airtable.update(this.tables.attempts, existing.id, { Status: 'expired' })
        }
      }
      const attemptId = crypto.randomUUID()
      if (!enrollmentToken && !participantEmail) throw new EnrollmentAuthorizationError()
      if (enrollmentToken) this.enrollment.bindAttempt(enrollmentToken, assessment.id, attemptId)
      const startedAt = new Date()
      const deadline = new Date(startedAt.getTime() + assessment.durationMinutes * 60_000)
      const record = await this.airtable.create(this.tables.attempts, {
        AttemptId: attemptId,
        AssessmentId: assessment.id,
        ParticipantDisplayName: participantDisplayName.trim(),
        ...(participantEmail ? { ParticipantEmail: participantEmail } : {}),
        StartedAt: startedAt.toISOString(),
        Status: 'in_progress',
        AnswersJSON: '[]'
      })
      return {
        attemptId,
        assessmentId: assessment.id,
        recordId: record.id,
        status: 'in_progress',
        startedAt: startedAt.toISOString(),
        deadline: deadline.toISOString()
      }
    } finally {
      if (participantKey) this.participantAttemptCreations.delete(participantKey)
    }
  }

  async submit(
    attemptId: string,
    assessmentId: string,
    answers: unknown,
    enrollmentToken?: string,
    trustedAuthorization = false,
    trigger?: 'deadline'
  ): Promise<{ submissionId: string; submittedAt: string; status: 'accepted'; message: string }> {
    if (!isBoundedIdentifier(attemptId) || !isBoundedIdentifier(assessmentId)) {
      throw new ValidationError('Attempt or assessment ID is invalid.')
    }
    if (!trustedAuthorization) this.authorizeAttempt(enrollmentToken, assessmentId, attemptId)
    const pending = this.submissionLocks.get(attemptId)
    if (pending) return pending
    const operation = this.submitOnce(attemptId, assessmentId, answers, trigger)
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
    answers: unknown,
    trigger?: 'deadline'
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
    const deadlineReached = Date.now() >= startedAt + assessment.durationMinutes * 60_000
    if (deadlineReached && trigger !== 'deadline') {
      await this.airtable.update(this.tables.attempts, attempt.id, { Status: 'expired' })
      throw new ValidationError('Assessment deadline has expired.')
    }
    if (trigger === 'deadline' && !deadlineReached) {
      throw new ValidationError('The assessment deadline has not been reached.')
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
  ): Promise<AssessmentAuditEvent> {
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
    const status = stringField(attempt, 'Status')
    if (event.type === 'assessment_submitted') {
      if (status !== 'submitted' || !optionalStringField(attempt, 'SubmittedAt')) {
        throw new ValidationError('Assessment submission activity is not confirmed.')
      }
    } else {
      const isDeadlineSubmission =
        event.type === 'automatic_submission_deadline' &&
        (status === 'in_progress' ||
          (status === 'submitted' && Boolean(optionalStringField(attempt, 'SubmittedAt'))))
      if (status !== 'in_progress' && !isDeadlineSubmission) {
        throw new ValidationError('Assessment activity is no longer active.')
      }
      if (status === 'in_progress' && event.type !== 'automatic_submission_deadline') {
        const assessment = await this.getPublishedAssessment(assessmentId)
        const startedAt = Date.parse(stringField(attempt, 'StartedAt'))
        if (
          !Number.isFinite(startedAt) ||
          Date.now() >= startedAt + assessment.durationMinutes * 60_000
        ) {
          throw new ValidationError('Assessment activity is no longer active.')
        }
      }
    }
    return this.auditStore.append(assessmentId, attemptId, event)
  }

  async listActivityEvents(
    attemptId: string,
    assessmentId: string
  ): Promise<AssessmentAuditEvent[]> {
    if (!this.auditStore) throw new ValidationError('Activity logging is unavailable.')
    if (!isBoundedIdentifier(attemptId) || !isBoundedIdentifier(assessmentId)) {
      throw new ValidationError('Attempt or assessment ID is invalid.')
    }
    const records = await this.airtable.list(
      this.tables.attempts,
      `{AttemptId} = '${escapeFormula(attemptId)}'`
    )
    const attempt = records[0]
    if (!attempt || stringField(attempt, 'AssessmentId') !== assessmentId) {
      throw new NotFoundError('Attempt not found.')
    }
    return this.auditStore.list(attemptId)
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
export class AssessmentDraftWriteError extends Error {
  constructor(
    readonly assessmentId: string,
    readonly savedQuestionCount: number,
    cause: unknown
  ) {
    super('The assessment draft was created, but question persistence stopped partway through.', {
      cause
    })
    this.name = 'AssessmentDraftWriteError'
  }
}

function validateAssessmentDraft(value: unknown): asserts value is AdminAssessmentDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Assessment draft must be an object.')
  }
  const draft = value as Record<string, unknown>
  if (
    typeof draft.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(draft.id) ||
    typeof draft.title !== 'string' ||
    !draft.title.trim() ||
    draft.title.length > 200 ||
    typeof draft.instructions !== 'string' ||
    !draft.instructions.trim() ||
    draft.instructions.length > 2_000 ||
    !Array.isArray(draft.questions) ||
    draft.questions.length < 1 ||
    draft.questions.length > 20
  ) {
    throw new ValidationError('Assessment title, ID, instructions, or question count is invalid.')
  }
  boundedDuration(draft.durationMinutes)
  const ids = new Set<string>()
  const prompts = new Set<string>()
  for (const [index, rawQuestion] of draft.questions.entries()) {
    if (typeof rawQuestion !== 'object' || rawQuestion === null || Array.isArray(rawQuestion)) {
      throw new ValidationError(`Question ${index + 1} is invalid.`)
    }
    const question = rawQuestion as Record<string, unknown>
    if (
      typeof question.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(question.id) ||
      ids.has(question.id) ||
      typeof question.prompt !== 'string' ||
      !question.prompt.trim() ||
      question.prompt.length > 2_000 ||
      typeof question.explanation !== 'string' ||
      !question.explanation.trim() ||
      question.explanation.length > 2_000 ||
      typeof question.topic !== 'string' ||
      !question.topic.trim() ||
      question.topic.length > 300 ||
      (question.difficulty !== 'Easy' &&
        question.difficulty !== 'Medium' &&
        question.difficulty !== 'Hard') ||
      question.order !== index + 1
    ) {
      throw new ValidationError(`Question ${index + 1} is incomplete or invalid.`)
    }
    ids.add(question.id)
    const promptKey = question.prompt.trim().toLowerCase().replace(/\s+/g, ' ')
    if (prompts.has(promptKey)) {
      throw new ValidationError('Assessment questions must not contain duplicate question text.')
    }
    prompts.add(promptKey)
    const options = parseQuestionOptions(question.options)
    if (
      typeof question.correctOptionId !== 'string' ||
      !options.some((option) => option.id === question.correctOptionId)
    ) {
      throw new ValidationError(`Question ${index + 1} has an invalid answer key.`)
    }
  }
}

export function parseQuestionOptions(raw: unknown): AssessmentOption[] {
  if (raw === undefined || raw === null || raw === '') {
    throw new ValidationError('Question OptionsJSON is missing.')
  }
  let parsed: unknown
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw new ValidationError('Question OptionsJSON is malformed JSON.')
  }
  if (!Array.isArray(parsed)) {
    throw new ValidationError('Question OptionsJSON must be a JSON array.')
  }
  if (parsed.length !== 4) {
    throw new ValidationError('Question OptionsJSON must contain exactly four options.')
  }
  if (
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
      'Each Question OptionsJSON option must have non-empty id and text strings.'
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

function optionalNumberField(record: AirtableRecord, field: string): number | null {
  const value = record.fields[field]
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function numberField(record: AirtableRecord, field: string): number {
  const value = record.fields[field]
  return typeof value === 'number' ? value : Number(value)
}

function parseAnsweredQuestionCount(
  value: unknown,
  activeQuestionIds: ReadonlySet<string>
): number | null {
  if (typeof value !== 'string') return null
  let answers: unknown
  try {
    answers = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(answers) || answers.length > 100) return null
  const questionIds = new Set<string>()
  for (const answer of answers) {
    if (!isAnswer(answer) || !activeQuestionIds.has(answer.questionId)) return null
    questionIds.add(answer.questionId)
  }
  return questionIds.size
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
