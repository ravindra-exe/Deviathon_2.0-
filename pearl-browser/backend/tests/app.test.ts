import { describe, expect, it } from 'vitest'
import type { AirtableClient, AirtableRecord } from '../src/airtable'
import { createApp } from '../src/app'
import { AssessmentService } from '../src/service'
import { EnrollmentTokenStore } from '../src/enrollment'
import { OtpAuthService } from '../src/auth'
import type { OtpDelivery, OtpMessage } from '../src/mailer'
import { AssessmentAuditStore } from '../src/audit'

const attempts: AirtableRecord[] = []
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
