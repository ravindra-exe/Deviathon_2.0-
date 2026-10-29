import { describe, expect, it } from 'vitest'
import type { AirtableClient, AirtableRecord } from '../src/airtable'
import { AssessmentService, ValidationError } from '../src/service'
import { EnrollmentTokenStore } from '../src/enrollment'

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

  async list(table: string): Promise<AirtableRecord[]> {
    return this.records[table] ?? []
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

  it('creates and idempotently accepts a valid submission', async () => {
    const current = service()
    const token = current.issueEnrollmentToken('assessment-1').token
    const attempt = await current.createAttempt('assessment-1', 'Ravi', token)
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
})
