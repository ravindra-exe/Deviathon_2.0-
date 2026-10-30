import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AirtableClient, AirtableRecord } from '../src/airtable'
import { createApp } from '../src/app'
import { AirtableRequestError } from '../src/airtable'
import { AssessmentService } from '../src/service'
import { EnrollmentTokenStore } from '../src/enrollment'
import { OtpAuthService } from '../src/auth'
import type { OtpDelivery, OtpMessage } from '../src/mailer'
import { AdminActionAuditStore, AssessmentAuditStore } from '../src/audit'
import type { AssessmentAuditEvent } from '../src/audit'
import type { ProctoringInsightResult } from '../../src/shared/assessment'
import type { ProctoringInsightProvider } from '../src/proctoringInsights'
import type { QuestionGenerationProvider } from '../src/questionGeneration'

const attempts: AirtableRecord[] = []
function authorizationHeader(session: { sessionId: string; token: string }): {
  authorization: string
} {
  return { authorization: ['Bearer', `${session.sessionId}.${session.token}`].join(' ') }
}

const client: AirtableClient = {
  async list(table: string, filterByFormula?: string): Promise<AirtableRecord[]> {
    if (table === 'Assessments') {
      return [
        {
          id: 'a',
          fields: {
            AssessmentId: 'a1',
            Title: 'A',
            Instructions: 'I',
            DurationMinutes: 5,
            IsPublished: true
          }
        }
      ]
    }
    if (table === 'Questions') {
      return [
        {
          id: 'q',
          fields: {
            QuestionId: 'q1',
            Prompt: 'P',
            OptionsJSON: JSON.stringify([
              { id: 'A', text: 'Alpha' },
              { id: 'B', text: 'Beta' },
              { id: 'C', text: 'Gamma' },
              { id: 'D', text: 'Delta' }
            ]),
            Order: 1,
            IsActive: true
          }
        }
      ]
    }
    if (!filterByFormula) return attempts
    const match = /\{AttemptId\} = '([^']+)'/.exec(filterByFormula)
    return match ? attempts.filter((attempt) => attempt.fields.AttemptId === match[1]) : attempts
  },
  async create(_table, fields) {
    const record = { id: `attempt-record-${attempts.length + 1}`, fields }
    attempts.push(record)
    return record
  },
  async update(_table, recordId, fields) {
    const record = attempts.find((item) => item.id === recordId)
    if (record) record.fields = { ...record.fields, ...fields }
    return record ?? { id: recordId, fields }
  }
}

class TestDelivery implements OtpDelivery {
  messages: OtpMessage[] = []
  async send(message: OtpMessage): Promise<void> {
    this.messages.push(message)
  }
}

class FailingDelivery implements OtpDelivery {
  async send(): Promise<void> {
    throw new Error('SMTP unavailable')
  }
}

function assessmentService(auditStore = new AssessmentAuditStore()): AssessmentService {
  return new AssessmentService(
    client,
    { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
    new EnrollmentTokenStore(true),
    auditStore
  )
}

describe('assessment API', () => {
  it('serves dashboard overview data when a question record has malformed options', async () => {
    const invalidQuestionClient: AirtableClient = {
      async list(table, filterByFormula) {
        const records = await client.list(table, filterByFormula)
        if (table !== 'Questions') return records
        return records.map((record) => ({
          ...record,
          fields: { ...record.fields, OptionsJSON: '{invalid' }
        }))
      },
      create: (table, fields) => client.create(table, fields),
      update: (table, recordId, fields) => client.update(table, recordId, fields)
    }
    const service = new AssessmentService(
      invalidQuestionClient,
      { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
      new EnrollmentTokenStore(true)
    )
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(assessmentService(), delivery, 'test-secret', () => 1_000, [
      'admin@example.com'
    ])
    const app = createApp(service, auth)

    await auth.requestAdminOtp('admin@example.com', 'ip')
    const session = auth.verifyAdminOtp('admin@example.com', delivery.messages[0].code)
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/console',
      headers: authorizationHeader(session)
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().metrics.totalAssessments).toBe(1)
    expect(response.json().questions[0]).toMatchObject({
      id: 'q1',
      assessmentId: '',
      validationError: 'Question OptionsJSON is malformed JSON.'
    })
    expect(response.json().questionValidationErrors).toHaveLength(1)
    expect(response.body).not.toContain('CorrectOptionId')
    await app.close()
  })

  it('returns the structured AI insight only after administrator authentication', async () => {
    const auditStore = new AssessmentAuditStore()
    const insightClient: AirtableClient = {
      ...client,
      async list(table, filterByFormula) {
        if (table === 'Attempts') {
          return [
            {
              id: 'attempt-record',
              fields: { AttemptId: 'attempt-1', AssessmentId: 'a1', Status: 'submitted' }
            }
          ]
        }
        return client.list(table, filterByFormula)
      }
    }
    const service = new AssessmentService(
      insightClient,
      { assessments: 'Assessments', questions: 'Questions', attempts: 'Attempts' },
      new EnrollmentTokenStore(true),
      auditStore
    )
    const recorded = auditStore.append('a1', 'attempt-1', {
      type: 'face_not_detected',
      observationDurationMs: 5_200
    })
    let receivedEvents: readonly AssessmentAuditEvent[] = []
    const result: ProctoringInsightResult = {
      status: 'available',
      message: 'Structured recorded evidence summary.',
      provider: 'Google Gemini',
      model: 'gemini-test-model',
      summary: 'A sustained face absence signal was recorded.',
      observedFacts: [
        {
          eventId: recorded.id,
          type: recorded.type,
          occurredAt: recorded.occurredAt,
          observationDurationMs: recorded.observationDurationMs
        }
      ],
      supportingEventIds: [recorded.id],
      riskIndicators: [],
      confidenceLimitations: ['Metadata alone does not establish intent.'],
      reviewerRecommendations: ['Review the underlying event in context.']
    }
    const provider: ProctoringInsightProvider = {
      provider: 'Google Gemini',
      model: 'gemini-test-model',
      async summarize(events) {
        receivedEvents = events
        return result
      }
    }
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(service, delivery, 'test-secret', () => 1_000, [
      'admin@example.com'
    ])
    const app = createApp(service, auth, provider)
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/admin/attempts/attempt-1/insights?assessmentId=a1'
    })
    expect(unauthenticated.statusCode).toBe(401)

    await auth.requestAdminOtp('admin@example.com', 'ip')
    const session = auth.verifyAdminOtp('admin@example.com', delivery.messages[0].code)
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/attempts/attempt-1/insights?assessmentId=a1',
      headers: authorizationHeader(session)
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'available',
      provider: 'Google Gemini',
      model: 'gemini-test-model',
      summary: result.summary,
      observedFacts: result.observedFacts,
      confidenceLimitations: result.confidenceLimitations
    })
    expect(receivedEvents.map((event) => event.id)).toEqual([recorded.id])
    await app.close()
  })

  it('protects administrator data with an allowlisted verified OTP session', async () => {
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(assessmentService(), delivery, 'test-secret', () => 1_000, [
      'admin@example.com'
    ])
    const app = createApp(assessmentService(), auth)
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/admin/console' })
    expect(unauthenticated.statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/admin/auth/session' })).statusCode).toBe(
      401
    )

    await auth.requestOtp('participant@example.com', 'a1', 'ip')
    const participant = auth.verifyOtp('participant@example.com', 'a1', delivery.messages[0].code)
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/console',
      headers: { authorization: `Bearer ${participant.sessionId}.${participant.token}` }
    })
    expect(forbidden.statusCode).toBe(401)
    const forbiddenAudit = await app.inject({
      method: 'POST',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${participant.sessionId}.${participant.token}` },
      payload: { action: 'report_export', targetId: 'attempts' }
    })
    expect(forbiddenAudit.statusCode).toBe(401)

    const unauthorizedOtpRequest = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/otp/request',
      payload: { email: 'not-allowed@example.com' }
    })
    expect(unauthorizedOtpRequest.statusCode).toBe(403)
    expect(unauthorizedOtpRequest.json().error).toContain('not authorized')

    const otpRequest = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/otp/request',
      payload: { email: 'admin@example.com' }
    })
    expect(otpRequest.statusCode).toBe(202)
    expect(otpRequest.body).not.toContain(delivery.messages[1].code)
    const wrongCode = delivery.messages[1].code === '000000' ? '000001' : '000000'
    const failedVerification = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/otp/verify',
      payload: { email: 'admin@example.com', code: wrongCode }
    })
    expect(failedVerification.statusCode).toBe(401)
    expect(failedVerification.json().error).toContain('incorrect or expired')
    expect(failedVerification.body).not.toContain(delivery.messages[1].code)
    const verification = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/otp/verify',
      payload: { email: 'admin@example.com', code: delivery.messages[1].code }
    })
    expect(verification.statusCode).toBe(200)
    expect(verification.body).not.toContain(delivery.messages[1].code)
    const administrator = verification.json() as {
      sessionId: string
      token: string
      expiresAt: string
    }
    const sessionStatus = await app.inject({
      method: 'GET',
      url: '/api/admin/auth/session',
      headers: authorizationHeader(administrator)
    })
    expect(sessionStatus.statusCode).toBe(200)
    expect(sessionStatus.json()).toMatchObject({ authenticated: true })
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/console',
      headers: { authorization: `Bearer ${administrator.sessionId}.${administrator.token}` }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().metrics.totalAssessments).toBe(1)
    expect(JSON.stringify(response.json())).not.toContain('CorrectOptionId')
    const insights = await app.inject({
      method: 'GET',
      url: '/api/admin/attempts/attempt-1/insights?assessmentId=a1',
      headers: { authorization: `Bearer ${administrator.sessionId}.${administrator.token}` }
    })
    expect(insights.statusCode).toBe(200)
    expect(insights.json().status).toBe('not_configured')
    await app.close()
  })
  it('requires an allowlisted administrator session for question generation and returns provider metadata', async () => {
    const delivery = new TestDelivery()
    const assessment = assessmentService()
    const auth = new OtpAuthService(assessment, delivery, 'test-secret', () => 1_000, [
      'admin@example.com'
    ])
    const questions = [
      {
        id: 'temporary-1',
        prompt: 'Which structure contains genetic material?',
        options: [
          { id: 'A', text: 'Nucleus' },
          { id: 'B', text: 'Cell wall' },
          { id: 'C', text: 'Ribosome' },
          { id: 'D', text: 'Vacuole' }
        ],
        correctOptionId: 'A',
        explanation: 'The nucleus contains the genetic material.',
        difficulty: 'Medium' as const,
        topic: 'Cell structure',
        order: 1
      }
    ]
    const provider: QuestionGenerationProvider = {
      provider: 'Test provider',
      model: 'test-model',
      async generate() {
        return questions
      }
    }
    const app = createApp(assessment, auth, undefined, undefined, provider)
    const payload = {
      subject: 'Biology',
      topic: 'Cell structure',
      learningObjectives: 'Compare cell components.',
      difficulty: 'Medium',
      questionCount: 1,
      optionCount: 4,
      questionType: 'MCQ',
      audience: 'Grade 10',
      instructions: '',
      language: 'English'
    }
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/admin/question-generator/generate',
      payload
    })
    expect(unauthorized.statusCode).toBe(401)

    await auth.requestAdminOtp('admin@example.com', 'ip')
    const session = auth.verifyAdminOtp('admin@example.com', delivery.messages[0].code)
    const generated = await app.inject({
      method: 'POST',
      url: '/api/admin/question-generator/generate',
      headers: authorizationHeader(session),
      payload
    })
    expect(generated.statusCode).toBe(200)
    expect(generated.json()).toMatchObject({
      provider: 'Test provider',
      model: 'test-model',
      questions
    })
    await app.close()
  })
  it('returns metadata without questions and requires OTP for question retrieval', async () => {
    const delivery = new TestDelivery()
    const service = assessmentService()
    const auth = new OtpAuthService(service, delivery, 'test-secret', () => 1_000)
    const app = createApp(service, auth)
    const metadata = await app.inject({ method: 'GET', url: '/api/assessments/a1' })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json().assessment).toMatchObject({
      id: 'a1',
      title: 'A',
      durationMinutes: 5,
      questionCount: 1
    })
    expect(metadata.json().assessment).not.toHaveProperty('questions')

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/assessments/a1/questions'
    })
    expect(unauthorized.statusCode).toBe(401)

    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'participant@example.com', assessmentId: 'a1' }
    })
    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'participant@example.com',
        assessmentId: 'a1',
        code: delivery.messages[0].code
      }
    })
    const authenticatedSession = verification.json()
    const questions = await app.inject({
      method: 'GET',
      url: '/api/assessments/a1/questions',
      headers: {
        authorization: `Bearer ${authenticatedSession.sessionId}.${authenticatedSession.token}`
      }
    })
    expect(questions.statusCode).toBe(200)
    expect(questions.json().questions).toHaveLength(1)
    expect(questions.body).not.toContain('CorrectOptionId')
    await app.close()
  })

  it('records report exports with the verified administrator as actor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pearl-admin-api-test-'))
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(assessmentService(), delivery, 'test-secret', () => 1_000, [
      'admin@example.com'
    ])
    const app = createApp(
      assessmentService(),
      auth,
      undefined,
      new AdminActionAuditStore(join(directory, 'admin-actions.jsonl'))
    )
    try {
      await auth.requestAdminOtp('admin@example.com', 'ip')
      const session = auth.verifyAdminOtp('admin@example.com', delivery.messages[0].code)
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/audit',
        headers: { authorization: `Bearer ${session.sessionId}.${session.token}` },
        payload: { action: 'report_export', targetId: 'attempts' }
      })
      expect(response.statusCode).toBe(202)
      const event = JSON.parse(readFileSync(join(directory, 'admin-actions.jsonl'), 'utf8')) as {
        actorEmail: string
        action: string
        targetId: string
      }
      expect(event).toMatchObject({
        actorEmail: 'admin@example.com',
        action: 'report_export',
        targetId: 'attempts'
      })
    } finally {
      await app.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('invokes OTP delivery without returning the code', async () => {
    const delivery = new TestDelivery()
    const app = createApp(
      assessmentService(),
      new OtpAuthService(assessmentService(), delivery, 'test-secret', () => 1_000)
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'participant@example.com', assessmentId: 'a1' }
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({
      message: 'If this request is eligible, a verification code will be sent.'
    })
    expect(response.body).not.toContain(delivery.messages[0].code)
    expect(delivery.messages).toHaveLength(1)
    await app.close()
  })

  it('returns a safe service error when OTP delivery fails', async () => {
    const app = createApp(
      assessmentService(),
      new OtpAuthService(assessmentService(), new FailingDelivery(), 'test-secret', () => 1_000)
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'participant@example.com', assessmentId: 'a1' }
    })
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('SMTP unavailable')
    await app.close()
  })

  it('requires an authenticated session for attempt creation', async () => {
    const app = createApp(
      assessmentService(),
      new OtpAuthService(assessmentService(), new TestDelivery(), 'test-secret', () => 1_000)
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      payload: { participantDisplayName: 'Participant', email: 'participant@example.com' }
    })
    expect(response.statusCode).toBe(401)
    await app.close()
  })

  it('offers specific guidance when Airtable refuses a new status option', async () => {
    const app = createApp({
      createAttempt: async () => {
        throw new AirtableRequestError(
          422,
          'INVALID_MULTIPLE_CHOICE_OPTIONS',
          'Insufficient permissions to create new select option "expired"'
        )
      }
    } as never)
    const response = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization: 'Bearer test-token' },
      payload: { participantDisplayName: 'Participant' }
    })
    expect(response.statusCode).toBe(502)
    expect(response.json().error).toContain('Single select')
    expect(response.json().error).toContain('in_progress')
    expect(response.json().error).toContain('expired')
    await app.close()
  })

  it('allows a verified session and binds it to its attempt', async () => {
    const clock = { value: 1_000 }
    const delivery = new TestDelivery()
    const service = assessmentService()
    const auth = new OtpAuthService(service, delivery, 'test-secret', () => clock.value)
    const app = createApp(service, auth)
    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'participant@example.com', assessmentId: 'a1' }
    })
    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'participant@example.com',
        assessmentId: 'a1',
        code: delivery.messages[0].code
      }
    })
    expect(verification.statusCode).toBe(200)
    const session = verification.json()
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization: `Bearer ${session.sessionId}.${session.token}` },
      payload: { participantDisplayName: 'Participant' }
    })
    expect(attempt.statusCode).toBe(200)
    await app.close()
  })

  it('rejects expired, revoked, and cross-assessment sessions', async () => {
    const clock = { value: 1_000 }
    const delivery = new TestDelivery()
    const service = assessmentService()
    const auth = new OtpAuthService(service, delivery, 'test-secret', () => clock.value)
    const app = createApp(service, auth)
    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'participant@example.com', assessmentId: 'a1' }
    })
    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'participant@example.com',
        assessmentId: 'a1',
        code: delivery.messages[0].code
      }
    })
    const session = verification.json()
    const credential = `Bearer ${session.sessionId}.${session.token}`
    const crossAssessment = await app.inject({
      method: 'POST',
      url: '/api/assessments/a2/attempts',
      headers: { authorization: credential },
      payload: { participantDisplayName: 'Participant' }
    })
    expect(crossAssessment.statusCode).toBe(401)
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: credential }
    })
    const revoked = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization: credential },
      payload: { participantDisplayName: 'Participant' }
    })
    expect(revoked.statusCode).toBe(401)
    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'expired@example.com', assessmentId: 'a1' }
    })
    const expiredVerification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'expired@example.com',
        assessmentId: 'a1',
        code: delivery.messages[1].code
      }
    })
    const expiredSession = expiredVerification.json()
    const expiredCredential = `Bearer ${expiredSession.sessionId}.${expiredSession.token}`
    clock.value += 60 * 60_000
    const expired = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization: expiredCredential },
      payload: { participantDisplayName: 'Participant' }
    })
    expect(expired.statusCode).toBe(401)
    await app.close()
  })

  it('does not allow one authenticated session to use another session attempt', async () => {
    const firstClock = { value: 1_000 }
    const firstDelivery = new TestDelivery()
    const service = assessmentService()
    const firstAuth = new OtpAuthService(
      service,
      firstDelivery,
      'test-secret',
      () => firstClock.value
    )
    const firstApp = createApp(service, firstAuth)
    await firstApp.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'first@example.com', assessmentId: 'a1' }
    })
    const firstVerification = await firstApp.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'first@example.com',
        assessmentId: 'a1',
        code: firstDelivery.messages[0].code
      }
    })
    const firstSession = firstVerification.json()
    const firstAttempt = await firstApp.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: {
        authorization: `Bearer ${firstSession.sessionId}.${firstSession.token}`
      },
      payload: { participantDisplayName: 'First' }
    })

    const secondDelivery = new TestDelivery()
    const secondAuth = new OtpAuthService(service, secondDelivery, 'test-secret', () => 1_000)
    const secondApp = createApp(service, secondAuth)
    await secondApp.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'second@example.com', assessmentId: 'a1' }
    })
    const secondVerification = await secondApp.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'second@example.com',
        assessmentId: 'a1',
        code: secondDelivery.messages[0].code
      }
    })
    const secondSession = secondVerification.json()
    const response = await secondApp.inject({
      method: 'GET',
      url: `/api/attempts/${firstAttempt.json().attemptId}/submission?assessmentId=a1`,
      headers: {
        authorization: `Bearer ${secondSession.sessionId}.${secondSession.token}`
      }
    })
    expect(response.statusCode).toBe(401)
    await firstApp.close()
    await secondApp.close()
  })

  it('records only authorized active-attempt audit events', async () => {
    const auditStore = new AssessmentAuditStore()
    const service = assessmentService(auditStore)
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(service, delivery, 'test-secret', () => Date.now())
    const app = createApp(service, auth)
    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'audit@example.com', assessmentId: 'a1' }
    })
    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'audit@example.com',
        assessmentId: 'a1',
        code: delivery.messages[0].code
      }
    })
    const session = verification.json()
    const authorization = `Bearer ${session.sessionId}.${session.token}`
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization },
      payload: { participantDisplayName: 'Audit participant' }
    })
    const attemptId = attempt.json().attemptId
    const recorded = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/events`,
      headers: { authorization },
      payload: {
        assessmentId: 'a1',
        type: 'navigation_completed',
        url: 'https://example.com/private?token=secret',
        query: 'search token=secret'
      }
    })
    expect(recorded.statusCode).toBe(202)
    expect(auditStore.list(attemptId)[0]).toMatchObject({
      type: 'navigation_completed',
      url: 'https://example.com/private',
      query: 'search token=[redacted]'
    })
    const oversized = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/events`,
      headers: { authorization },
      payload: { assessmentId: 'a1', type: 'navigation_started', url: 'x'.repeat(513) }
    })
    expect(oversized.statusCode).toBe(400)
    await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/submissions`,
      headers: { authorization },
      payload: { assessmentId: 'a1', answers: [] }
    })
    const afterSubmission = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/events`,
      headers: { authorization },
      payload: { assessmentId: 'a1', type: 'face_detected' }
    })
    expect(afterSubmission.statusCode).toBe(400)
    await app.close()
  })

  it('accepts a deadline-triggered final submission only after the backend deadline', async () => {
    const auditStore = new AssessmentAuditStore()
    const service = assessmentService(auditStore)
    const delivery = new TestDelivery()
    const auth = new OtpAuthService(service, delivery, 'test-secret')
    const app = createApp(service, auth)
    await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      payload: { email: 'deadline@example.com', assessmentId: 'a1' }
    })
    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: {
        email: 'deadline@example.com',
        assessmentId: 'a1',
        code: delivery.messages[0].code
      }
    })
    expect(verification.statusCode).toBe(200)
    const session = verification.json()
    const authorization = `Bearer ${session.sessionId}.${session.token}`
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      headers: { authorization },
      payload: { participantDisplayName: 'Deadline participant' }
    })
    expect(attempt.statusCode).toBe(200)
    const attemptId = attempt.json().attemptId as string
    const attemptRecord = attempts.find((record) => record.fields.AttemptId === attemptId)
    expect(attemptRecord).toBeDefined()
    attemptRecord!.fields.StartedAt = new Date(Date.now() - 6 * 60_000).toISOString()

    const unmarkedSubmission = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/submissions`,
      headers: { authorization },
      payload: { assessmentId: 'a1', answers: [] }
    })
    expect(unmarkedSubmission.statusCode).toBe(400)

    const deadlineSubmission = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/submissions`,
      headers: { authorization },
      payload: { assessmentId: 'a1', answers: [], trigger: 'deadline' }
    })
    expect(deadlineSubmission.statusCode).toBe(200)
    expect(deadlineSubmission.json()).toMatchObject({ status: 'accepted' })

    const recorded = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attemptId}/events`,
      headers: { authorization },
      payload: { assessmentId: 'a1', type: 'automatic_submission_deadline' }
    })
    expect(recorded.statusCode).toBe(202)
    expect(auditStore.list(attemptId).map((event) => event.type)).toContain(
      'automatic_submission_deadline'
    )
    await app.close()
  })

  it('prevents a participant from creating a second active attempt', async () => {
    const service = assessmentService()
    await service.createAttempt('a1', 'Same participant', undefined, 'one-attempt@example.com')

    await expect(
      service.createAttempt('a1', 'Same participant', undefined, 'one-attempt@example.com')
    ).rejects.toThrow('An active assessment attempt already exists for this account.')
  })

  it('reports health and rejects invalid attempts', async () => {
    const app = createApp(
      new AssessmentService(
        client,
        {
          assessments: 'Assessments',
          questions: 'Questions',
          attempts: 'Attempts'
        },
        new EnrollmentTokenStore(true)
      )
    )
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json().status).toBe('ok')
    const enrollment = await app.inject({
      method: 'POST',
      url: '/api/dev/enrollment-tokens',
      payload: { assessmentId: 'a1' }
    })
    expect(enrollment.statusCode).toBe(200)
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      payload: { participantDisplayName: 'Ravi' },
      headers: { authorization: `Bearer ${enrollment.json().token}` }
    })
    expect(attempt.statusCode).toBe(200)
    const submission = await app.inject({
      method: 'POST',
      url: `/api/attempts/${attempt.json().attemptId}/submissions`,
      payload: { assessmentId: 'a1', answers: [{ questionId: 'q1', optionIndex: 'invalid' }] },
      headers: { authorization: `Bearer ${enrollment.json().token}` }
    })
    expect(submission.statusCode).toBe(400)
    await app.close()
  })

  it('returns client errors for malformed request bodies', async () => {
    const app = createApp(
      new AssessmentService(
        client,
        {
          assessments: 'Assessments',
          questions: 'Questions',
          attempts: 'Attempts'
        },
        new EnrollmentTokenStore(true)
      )
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/assessments/a1/attempts',
      payload: { participantDisplayName: 42 }
    })
    expect(response.statusCode).toBe(400)
    await app.close()
  })
})
