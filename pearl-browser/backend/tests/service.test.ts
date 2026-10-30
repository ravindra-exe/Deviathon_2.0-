import { describe, expect, it } from 'vitest'
import type { AirtableClient, AirtableRecord } from '../src/airtable'
import { AssessmentService, ValidationError } from '../src/service'
import { EnrollmentTokenStore } from '../src/enrollment'
import { AssessmentAuditStore } from '../src/audit'
import { AssessmentDraftRegistry } from '../src/questionDraftRegistry'

class FakeAirtable implements AirtableClient {
  records: Record<string, AirtableRecord[]> = {
    Assessments: [
      {
        id: 'rec-assessment',
        fields: {
          AssessmentId: 'assessment-1',
          Title: 'Remote assessment',
          Instructions: 'Read carefully.',
          DurationMinutes: 10,
          IsPublished: true
        }
      }
    ],
    Questions: [
      {
        id: 'rec-q1',
        fields: {
          QuestionId: 'q1',
          AssessmentId: 'assessment-1',
          Prompt: 'Choose one',
          OptionsJSON: JSON.stringify([
            { id: 'A', text: 'Alpha' },
            { id: 'B', text: 'Beta' },
            { id: 'C', text: 'Gamma' },
            { id: 'D', text: 'Delta' }
          ]),
          Order: 1,
          IsActive: true,
          CorrectOptionId: 'hidden'
        }
      },
      {
        id: 'rec-inactive',
        fields: {
          QuestionId: 'inactive',
          AssessmentId: 'assessment-1',
          Prompt: 'Do not show',
          OptionsJSON: JSON.stringify([
            { id: 'A', text: 'Alpha' },
            { id: 'B', text: 'Beta' },
            { id: 'C', text: 'Gamma' },
            { id: 'D', text: 'Delta' }
          ]),
          Order: 2,
          IsActive: false
        }
      }
    ],
    Attempts: []
  }

  async list(table: string, filterByFormula?: string): Promise<AirtableRecord[]> {
    const records = this.records[table] ?? []
    const match = filterByFormula?.match(/\{(AssessmentId|AttemptId)\} = '([^']+)'/)
    if (!match) return records
    return records.filter((record) => record.fields[match[1]] === match[2])
  }

  async create(table: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
    const record = { id: `rec-${this.records[table].length + 1}`, fields }
    this.records[table].push(record)
    return record
  }

  async update(
    table: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<AirtableRecord> {
    const record = this.records[table].find((item) => item.id === recordId)
    if (!record) throw new Error('missing record')
    record.fields = { ...record.fields, ...fields }
    return record
  }
}

function service(fake = new FakeAirtable()): AssessmentService {
  return new AssessmentService(
    fake,
    {
      assessments: 'Assessments',
      questions: 'Questions',
      attempts: 'Attempts'
    },
    new EnrollmentTokenStore(true)
  )
}

describe('AssessmentService', () => {
  it('maps published questions and excludes inactive and answer-key fields', async () => {
    const assessment = await service().getPublishedAssessment('assessment-1')
    expect(assessment.questions).toEqual([
      {
        id: 'q1',
        prompt: 'Choose one',
        options: [
          { id: 'A', text: 'Alpha' },
          { id: 'B', text: 'Beta' },
          { id: 'C', text: 'Gamma' },
          { id: 'D', text: 'Delta' }
        ]
      }
    ])
    expect(JSON.stringify(assessment)).not.toContain('CorrectOptionId')
  })

  it('builds an admin snapshot from real records without returning answer keys or event URLs', async () => {
    const fake = new FakeAirtable()
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    fake.records.Attempts = [
      {
        id: 'attempt-1',
        fields: {
          AttemptId: 'attempt-1',
          AssessmentId: 'assessment-1',
          ParticipantEmail: 'one@example.com',
          Status: 'in_progress',
          StartedAt: startedAt
        }
      },
      {
        id: 'attempt-2',
        fields: {
          AttemptId: 'attempt-2',
          AssessmentId: 'assessment-1',
          ParticipantEmail: 'two@example.com',
          Status: 'submitted',
          StartedAt: startedAt,
          AnswersJSON: JSON.stringify([{ questionId: 'q1', optionIndex: 1 }])
        }
      },
      {
        id: 'attempt-3',
        fields: {
          AttemptId: 'attempt-3',
          AssessmentId: 'assessment-1',
          ParticipantEmail: 'two@example.com',
          Status: 'expired',
          StartedAt: startedAt
        }
      }
    ]
    const audit = new AssessmentAuditStore()
    audit.append('assessment-1', 'attempt-1', {
      type: 'navigation_started',
      hostname: 'example.com',
      url: 'https://example.com/?token=private'
    })
    const current = new AssessmentService(
      fake,
      { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
      new EnrollmentTokenStore(true),
      audit
    )
    const snapshot = await current.getAdminConsoleData()

    expect(snapshot.metrics).toMatchObject({
      totalAssessments: 1,
      publishedAssessments: 1,
      totalCandidates: 2,
      activeAttempts: 1,
      submittedAttempts: 1,
      expiredAttempts: 1,
      failedAttempts: 0
    })
    expect(snapshot.attempts[0].status).toBe('in_progress')
    expect(snapshot.attempts[0].deadline).toBeTruthy()
    expect(snapshot.attempts[0]).toMatchObject({
      answeredQuestionCount: null,
      totalQuestionCount: 1
    })
    expect(snapshot.attempts[1]).toMatchObject({
      answeredQuestionCount: 1,
      totalQuestionCount: 1
    })
    expect(snapshot.events[0]).not.toHaveProperty('url')
    expect(JSON.stringify(snapshot)).not.toContain('CorrectOptionId')
    expect(JSON.stringify(snapshot)).not.toContain('token=private')
  })

  it('keeps dashboard overview data available and reports invalid question options', async () => {
    const fake = new FakeAirtable()
    fake.records.Questions[1].fields.OptionsJSON = '{invalid'

    const snapshot = await service(fake).getAdminConsoleData()

    expect(snapshot.metrics.totalAssessments).toBe(1)
    expect(snapshot.assessments[0]).toMatchObject({
      id: 'assessment-1',
      questionCount: 2,
      attemptCount: 0
    })
    expect(snapshot.questions).toHaveLength(2)
    expect(snapshot.questions[0].options).toHaveLength(4)
    expect(snapshot.questions[1]).toMatchObject({
      recordId: 'rec-inactive',
      id: 'inactive',
      assessmentId: 'assessment-1',
      options: [],
      validationError: 'Question OptionsJSON is malformed JSON.'
    })
    expect(snapshot.questionValidationErrors).toEqual([
      {
        recordId: 'rec-inactive',
        questionId: 'inactive',
        assessmentId: 'assessment-1',
        message: 'Question OptionsJSON is malformed JSON.'
      }
    ])
    expect(JSON.stringify(snapshot)).not.toContain('CorrectOptionId')
  })

  it('creates and idempotently accepts a valid submission', async () => {
    const fake = new FakeAirtable()
    const current = service(fake)
    const token = current.issueEnrollmentToken('assessment-1').token
    const attempt = await current.createAttempt('assessment-1', 'Ravi', token)
    expect(attempt.status).toBe('in_progress')
    const first = await current.submit(
      attempt.attemptId,
      'assessment-1',
      [{ questionId: 'q1', optionIndex: 1 }],
      token
    )
    const second = await current.submit(
      attempt.attemptId,
      'assessment-1',
      [{ questionId: 'q1', optionIndex: 0 }],
      token
    )
    expect(first.status).toBe('accepted')
    expect(fake.records.Attempts[0].fields.Status).toBe('submitted')
    expect(second.submissionId).toBe(first.submissionId)
    expect(second.message).toContain('already')
  })

  it('rejects invalid option IDs', async () => {
    const current = service()
    const token = current.issueEnrollmentToken('assessment-1').token
    const attempt = await current.createAttempt('assessment-1', 'Ravi', token)
    await expect(
      current.submit(
        attempt.attemptId,
        'assessment-1',
        [{ questionId: 'q1', optionIndex: 4 }],
        token
      )
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a published assessment without active questions', async () => {
    const fake = new FakeAirtable()
    fake.records.Questions = []
    await expect(service(fake).getPublishedAssessment('assessment-1')).rejects.toThrow(
      'no active questions'
    )
  })

  it.each([
    ['invalid JSON', '{'],
    ['empty string', ''],
    ['missing field', undefined],
    ['null value', null],
    ['object instead of array', JSON.stringify({ A: 'Alpha' })],
    ['fewer than four options', JSON.stringify([{ id: 'A', text: 'Alpha' }])],
    [
      'empty option ID',
      JSON.stringify([
        { id: '', text: 'Alpha' },
        { id: 'B', text: 'Beta' },
        { id: 'C', text: 'Gamma' },
        { id: 'D', text: 'Delta' }
      ])
    ],
    [
      'empty option text',
      JSON.stringify([
        { id: 'A', text: '' },
        { id: 'B', text: 'Beta' },
        { id: 'C', text: 'Gamma' },
        { id: 'D', text: 'Delta' }
      ])
    ],
    [
      'duplicate option IDs',
      JSON.stringify([
        { id: 'A', text: 'Alpha' },
        { id: 'A', text: 'Beta' },
        { id: 'C', text: 'Gamma' },
        { id: 'D', text: 'Delta' }
      ])
    ]
  ])('rejects malformed OptionsJSON: %s', async (_label, options) => {
    const fake = new FakeAirtable()
    fake.records.Questions[0].fields.OptionsJSON = options
    await expect(service(fake).getPublishedAssessment('assessment-1')).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('rejects a submission after the server-side deadline', async () => {
    const fake = new FakeAirtable()
    const current = service(fake)
    const token = current.issueEnrollmentToken('assessment-1').token
    const attempt = await current.createAttempt('assessment-1', 'Ravi', token)
    const record = fake.records.Attempts[0]
    record.fields.StartedAt = new Date(Date.now() - 11 * 60_000).toISOString()
    await expect(
      current.submit(
        attempt.attemptId,
        'assessment-1',
        [{ questionId: 'q1', optionIndex: 0 }],
        token
      )
    ).rejects.toThrow('deadline has expired')
    expect(record.fields.Status).toBe('expired')
  })

  it('saves a validated assessment and questions as unpublished Airtable records, then explicitly publishes', async () => {
    const fake = new FakeAirtable()
    const registry = new AssessmentDraftRegistry()
    const current = new AssessmentService(
      fake,
      { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
      new EnrollmentTokenStore(true),
      undefined,
      registry
    )
    await current.saveAssessmentDraft({
      id: 'ai-paper-1',
      title: 'Cell structures',
      instructions: 'Select one answer.',
      durationMinutes: 20,
      questions: [
        {
          id: 'generated-1',
          prompt: 'Which part contains genetic material?',
          options: [
            { id: 'B', text: 'Cell wall' },
            { id: 'A', text: 'Nucleus' },
            { id: 'C', text: 'Ribosome' },
            { id: 'D', text: 'Vacuole' }
          ],
          correctOptionId: 'A',
          explanation: 'The nucleus contains the genetic material.',
          difficulty: 'Easy',
          topic: 'Cell structure',
          order: 1
        }
      ]
    })
    const savedAssessment = fake.records.Assessments.find(
      (record) => record.fields.AssessmentId === 'ai-paper-1'
    )
    expect(savedAssessment?.fields).toMatchObject({
      Title: 'Cell structures',
      DurationMinutes: 20,
      IsPublished: false
    })
    const savedQuestion = fake.records.Questions[fake.records.Questions.length - 1]
    expect(savedQuestion?.fields).toMatchObject({
      QuestionId: 'generated-1',
      AssessmentId: 'ai-paper-1',
      CorrectOptionId: 'A',
      IsActive: true,
      Order: 1
    })
    expect(JSON.parse(String(savedQuestion?.fields.OptionsJSON))).toEqual([
      { id: 'B', text: 'Cell wall' },
      { id: 'A', text: 'Nucleus' },
      { id: 'C', text: 'Ribosome' },
      { id: 'D', text: 'Vacuole' }
    ])
    expect(savedQuestion?.fields).not.toHaveProperty('Explanation')

    await current.publishAssessmentDraft('ai-paper-1')
    expect(savedAssessment?.fields.IsPublished).toBe(true)
  })

  it('does not publish drafts not registered by the generator and rejects invalid stored answer keys', async () => {
    const fake = new FakeAirtable()
    const registry = new AssessmentDraftRegistry()
    const current = new AssessmentService(
      fake,
      { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
      new EnrollmentTokenStore(true),
      undefined,
      registry
    )
    await expect(current.publishAssessmentDraft('assessment-1')).rejects.toThrow(
      'Only a draft created by the AI Question Generator'
    )

    await registry.register('assessment-1')
    fake.records.Assessments[0].fields.IsPublished = false
    fake.records.Questions[0].fields.CorrectOptionId = 'not-an-option'
    await expect(current.publishAssessmentDraft('assessment-1')).rejects.toThrow(
      'invalid answer key'
    )
    expect(fake.records.Assessments[0].fields.IsPublished).toBe(false)
  })
})
