import Fastify, { type FastifyInstance } from 'fastify'
import type { AssessmentService, AssessmentData, AttemptData } from './service'
import { NotFoundError, ValidationError } from './service'
import { EnrollmentAuthorizationError, EnrollmentDisabledError } from './enrollment'
import { AuthError, OtpAuthService } from './auth'
import { auditEventTypes, type AuditEventInput } from './audit'

export function createApp(service: AssessmentService, auth?: OtpAuthService): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })
  app.get('/health', async () => ({ status: 'ok', service: 'pearl-assessment-backend' }))
  app.post<{ Body: { email?: string; assessmentId?: string } }>(
    '/api/auth/otp/request',
    async (request, reply) => {
      if (
        !auth ||
        !isRecord(request.body) ||
        typeof request.body.email !== 'string' ||
        typeof request.body.assessmentId !== 'string'
      ) {
        return reply.code(400).send({ error: 'Invalid authentication request.' })
      }
      try {
        await auth.requestOtp(request.body.email, request.body.assessmentId, request.ip)
        return reply
          .code(202)
          .send({ message: 'If this request is eligible, a verification code will be sent.' })
      } catch (error) {
        if (error instanceof AuthError && error.code === 'rate_limit')
          return reply
            .code(429)
            .send({ error: 'Too many authentication requests. Try again later.' })
        if (error instanceof AuthError && error.code === 'configuration')
          return reply.code(503).send({ error: 'Authentication delivery is unavailable.' })
        return reply.code(400).send({ error: 'Invalid authentication request.' })
      }
    }
  )
  app.post<{ Body: { email?: string; assessmentId?: string; code?: string } }>(
    '/api/auth/otp/verify',
    async (request, reply) => {
      if (
        !auth ||
        !isRecord(request.body) ||
        typeof request.body.email !== 'string' ||
        typeof request.body.assessmentId !== 'string' ||
        typeof request.body.code !== 'string'
      ) {
        return reply.code(401).send({ error: 'Authentication failed.' })
      }
      try {
        const session = auth.verifyOtp(
          request.body.email,
          request.body.assessmentId,
          request.body.code
        )
        return {
          sessionId: session.sessionId,
          token: session.token,
          assessmentId: session.assessmentId,
          expiresAt: session.expiresAt
        }
      } catch {
        return reply.code(401).send({ error: 'Authentication failed.' })
      }
    }
  )
  app.get('/api/auth/session', async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: 'Authentication is unavailable.' })
    try {
      const identity = auth.session(bearerToken(request.headers.authorization))
      return {
        authenticated: true,
        assessmentId: identity.assessmentId,
        participantId: identity.participantId,
        expiresAt: identity.expiresAt
      }
    } catch {
      return reply.code(401).send({ authenticated: false })
    }
  })
  app.post<{
    Params: { attemptId: string }
    Body: { assessmentId?: string; type?: string; hostname?: string; url?: string; query?: string }
  }>('/api/attempts/:attemptId/events', async (request, reply) => {
    try {
      if (
        !auth ||
        !isBoundedString(request.params.attemptId) ||
        !isRecord(request.body) ||
        typeof request.body.assessmentId !== 'string'
      ) {
        return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
      }
      const credential = bearerToken(request.headers.authorization)
      auth.authorizeAttempt(credential, request.body.assessmentId, request.params.attemptId)
      const event = parseAuditEvent(request.body)
      await service.recordActivityEvent(request.params.attemptId, request.body.assessmentId, event)
      return reply.code(202).send({ accepted: true })
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.post('/api/auth/logout', async (request) => {
    auth?.logout(bearerToken(request.headers.authorization))
    return { ok: true }
  })
  app.post<{ Body: { assessmentId?: string } }>(
    '/api/dev/enrollment-tokens',
    async (request, reply) => {
      try {
        if (!isRecord(request.body) || !isBoundedString(request.body.assessmentId)) {
          return reply.code(400).send({ error: 'Invalid enrollment request.' })
        }
        return service.issueEnrollmentToken(request.body.assessmentId)
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.get<{ Params: { assessmentId: string } }>(
    '/api/assessments/:assessmentId',
    async (request, reply) => {
      try {
        if (!isBoundedString(request.params.assessmentId)) {
          return reply.code(400).send({ error: 'Assessment ID is invalid.' })
        }
        return {
          assessment: withoutRecordId(
            await service.getPublishedAssessment(request.params.assessmentId)
          )
        }
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.post<{ Params: { assessmentId: string }; Body: { participantDisplayName?: string } }>(
    '/api/assessments/:assessmentId/attempts',
    async (request, reply) => {
      try {
        if (!isBoundedString(request.params.assessmentId) || !isRecord(request.body)) {
          return reply.code(400).send({ error: 'Invalid attempt request.' })
        }
        const credential = bearerToken(request.headers.authorization)
        const identity =
          auth && credential ? auth.authorize(credential, request.params.assessmentId) : undefined
        const result = await service.createAttempt(
          request.params.assessmentId,
          typeof request.body.participantDisplayName === 'string'
            ? request.body.participantDisplayName
            : '',
          auth ? undefined : credential,
          identity?.email
        )
        if (identity) auth!.bindAttempt(credential, result.attemptId)
        return withoutRecordId(result)
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.post<{
    Params: { attemptId: string }
    Body: { assessmentId?: string; answers?: unknown }
  }>('/api/attempts/:attemptId/submissions', async (request, reply) => {
    try {
      if (
        !isBoundedString(request.params.attemptId) ||
        !isRecord(request.body) ||
        typeof request.body.assessmentId !== 'string'
      ) {
        return reply.code(400).send({ error: 'Invalid submission request.' })
      }
      const credential = bearerToken(request.headers.authorization)
      if (auth && credential)
        auth.authorizeAttempt(credential, request.body.assessmentId, request.params.attemptId)
      return await service.submit(
        request.params.attemptId,
        request.body.assessmentId,
        request.body.answers,
        auth && credential ? undefined : credential,
        Boolean(auth && credential)
      )
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.get<{ Params: { attemptId: string }; Querystring: { assessmentId?: string } }>(
    '/api/attempts/:attemptId/submission',
    async (request, reply) => {
      try {
        if (!isBoundedString(request.params.attemptId)) {
          return reply.code(400).send({ error: 'Attempt ID is invalid.' })
        }
        const assessmentId = request.query.assessmentId
        if (!isBoundedString(assessmentId)) {
          return reply.code(400).send({ error: 'Assessment ID is invalid.' })
        }
        const credential = bearerToken(request.headers.authorization)
        if (auth && credential)
          auth.authorizeAttempt(credential, assessmentId, request.params.attemptId)
        return await service.getSubmission(
          request.params.attemptId,
          assessmentId,
          auth && credential ? undefined : credential,
          Boolean(auth && credential)
        )
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  return app
}

function handleError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown
): unknown {
  if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
  if (error instanceof EnrollmentDisabledError)
    return reply.code(404).send({ error: 'Development enrollment is disabled.' })
  if (error instanceof EnrollmentAuthorizationError)
    return reply.code(401).send({ error: 'Enrollment authorization is invalid or expired.' })
  if (error instanceof AuthError)
    return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
  if (error instanceof AuthError)
    return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
  if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
  return reply.code(502).send({ error: 'Assessment backend upstream service unavailable.' })
}

function withoutRecordId(
  value: AssessmentData | AttemptData
): Omit<AssessmentData | AttemptData, 'recordId'> {
  const { recordId, ...publicValue } = value
  void recordId
  return publicValue
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAuditEvent(value: Record<string, unknown>): AuditEventInput {
  if (
    typeof value.type !== 'string' ||
    !auditEventTypes.includes(value.type as (typeof auditEventTypes)[number])
  ) {
    throw new ValidationError('Audit event type is invalid.')
  }
  const event: AuditEventInput = { type: value.type as AuditEventInput['type'] }
  for (const key of ['hostname', 'url', 'query'] as const) {
    const field = value[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > 512)) {
      throw new ValidationError('Audit event payload is invalid.')
    }
    if (typeof field === 'string' && field.length > 0) event[key] = sanitizeAuditField(key, field)
  }
  return event
}

function sanitizeAuditField(key: 'hostname' | 'url' | 'query', value: string): string {
  if (key === 'query') {
    return value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\b(password|passcode|secret|token|otp|code)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .slice(0, 256)
  }
  try {
    const parsed = new URL(value)
    return key === 'hostname' ? parsed.hostname.toLowerCase() : `${parsed.origin}${parsed.pathname}`
  } catch {
    if (key === 'hostname' && /^[a-z0-9.-]+$/i.test(value)) return value.toLowerCase()
    throw new ValidationError('Audit event URL is invalid.')
  }
}

function bearerToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length).trim()
  return token || undefined
}
