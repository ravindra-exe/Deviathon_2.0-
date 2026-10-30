import Fastify, { type FastifyInstance } from 'fastify'
import type { AssessmentService, AssessmentData, AttemptData } from './service'
import { AssessmentDraftWriteError, NotFoundError, ValidationError } from './service'
import { EnrollmentAuthorizationError, EnrollmentDisabledError } from './enrollment'
import { AuthError, OtpAuthService } from './auth'
import {
  AdminActionAuditStore,
  AdminAuditStorageError,
  auditEventTypes,
  type AuditEventInput
} from './audit'
import { AirtableRequestError } from './airtable'
import type { ProctoringInsightProvider } from './proctoringInsights'
import type { AdminAssessmentDraft } from '../../src/shared/admin'
import type { QuestionGenerationProvider } from './questionGeneration'
import { QuestionGenerationError, validateQuestionGenerationRequest } from './questionGeneration'
import { guardBrokenOutputPipe } from '../../src/shared/safeProcessOutput'

guardBrokenOutputPipe(process.stdout)
guardBrokenOutputPipe(process.stderr)

export function createApp(
  service: AssessmentService,
  auth?: OtpAuthService,
  insightProvider?: ProctoringInsightProvider,
  adminAuditStore?: AdminActionAuditStore,
  questionGenerationProvider?: QuestionGenerationProvider
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 })
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
        logAuthenticationFailure(
          'otp_request',
          error instanceof AuthError
            ? (error.diagnosticReason ?? error.code)
            : 'assessment_lookup_or_delivery_failed'
        )
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
        logAuthenticationFailure('otp_verify', auth ? 'invalid_request' : 'auth_unavailable')
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
      } catch (error) {
        logAuthenticationFailure(
          'otp_verify',
          error instanceof AuthError
            ? (error.diagnosticReason ?? error.code)
            : 'session_creation_failed'
        )
        if (error instanceof AuthError && error.code === 'conflict') {
          return reply
            .code(409)
            .send({ error: 'An active assessment session already exists for this account.' })
        }
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
        role: identity.role,
        ...(identity.role === 'participant'
          ? { assessmentId: identity.assessmentId, participantId: identity.participantId }
          : {}),
        expiresAt: identity.expiresAt
      }
    } catch {
      return reply.code(401).send({ authenticated: false })
    }
  })
  app.post<{ Body: { email?: string } }>('/api/admin/auth/otp/request', async (request, reply) => {
    if (!auth || !isRecord(request.body) || typeof request.body.email !== 'string') {
      return reply
        .code(202)
        .send({ message: 'If this address is authorized, a verification code will be sent.' })
    }
    try {
      await auth.requestAdminOtp(request.body.email, request.ip)
      return reply
        .code(202)
        .send({ message: 'If this address is authorized, a verification code will be sent.' })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'unauthorized') {
        logAuthenticationFailure('admin_otp_request', error.diagnosticReason ?? error.code)
        return reply.code(403).send({
          error: 'This email address is not authorized for the Admin Console.'
        })
      }
      if (error instanceof AuthError && error.code === 'invalid') {
        return reply.code(400).send({ error: error.message })
      }
      if (error instanceof AuthError && error.code === 'rate_limit') {
        return reply.code(429).send({ error: 'Too many authentication requests. Try again later.' })
      }
      logAuthenticationFailure(
        'admin_otp_request',
        error instanceof AuthError ? (error.diagnosticReason ?? error.code) : 'mail_delivery_failed'
      )
      return reply.code(503).send({ error: 'Authentication delivery is unavailable.' })
    }
  })
  app.post<{ Body: { email?: string; code?: string } }>(
    '/api/admin/auth/otp/verify',
    async (request, reply) => {
      if (
        !auth ||
        !isRecord(request.body) ||
        typeof request.body.email !== 'string' ||
        typeof request.body.code !== 'string'
      ) {
        return reply.code(401).send({ error: 'Authentication failed.' })
      }
      try {
        const session = auth.verifyAdminOtp(request.body.email, request.body.code)
        return {
          sessionId: session.sessionId,
          token: session.token,
          expiresAt: session.expiresAt
        }
      } catch (error) {
        logAuthenticationFailure(
          'admin_otp_verify',
          error instanceof AuthError
            ? (error.diagnosticReason ?? error.code)
            : 'session_creation_failed'
        )
        if (error instanceof AuthError && error.diagnosticReason === 'admin_not_allowed') {
          return reply.code(403).send({
            error: 'This email address is not authorized for the Admin Console.'
          })
        }
        if (!(error instanceof AuthError) || error.code === 'configuration') {
          return reply.code(503).send({
            error: 'Administrator authentication is temporarily unavailable. Try again later.'
          })
        }
        return reply.code(401).send({
          error: 'The verification code is incorrect or expired. Request a new code and try again.'
        })
      }
    }
  )
  app.get('/api/admin/auth/session', async (request, reply) => {
    try {
      if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
      const identity = auth.authorizeAdmin(bearerToken(request.headers.authorization))
      return { authenticated: true, expiresAt: identity.expiresAt }
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.get('/api/admin/console', async (request, reply) => {
    try {
      if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
      auth.authorizeAdmin(bearerToken(request.headers.authorization))
      return await service.getAdminConsoleData()
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.post('/api/admin/question-generator/generate', async (request, reply) => {
    try {
      if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
      auth.authorizeAdmin(bearerToken(request.headers.authorization))
      const generationRequest = validateQuestionGenerationRequest(request.body)
      if (!questionGenerationProvider) {
        return reply.code(503).send({
          error:
            'AI question generation is not configured. Set PEARL_PROCTORING_LLM_API_KEY and PEARL_PROCTORING_LLM_MODEL in the backend .env, then restart the backend.'
        })
      }
      const questions = await questionGenerationProvider.generate(generationRequest)
      return {
        provider: questionGenerationProvider.provider,
        model: questionGenerationProvider.model,
        questions
      }
    } catch (error) {
      if (error instanceof QuestionGenerationError) {
        return reply.code(error.statusCode).send({ error: error.message })
      }
      return handleError(reply, error)
    }
  })
  app.post<{ Body: AdminAssessmentDraft }>(
    '/api/admin/assessments/draft',
    async (request, reply) => {
      try {
        if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
        auth.authorizeAdmin(bearerToken(request.headers.authorization))
        if (!isRecord(request.body)) {
          return reply.code(400).send({ error: 'Assessment draft is invalid.' })
        }
        await service.saveAssessmentDraft(request.body)
        const draft = request.body
        return reply.code(201).send({
          assessmentId: draft.id,
          questionCount: Array.isArray(draft.questions) ? draft.questions.length : 0,
          published: false
        })
      } catch (error) {
        if (error instanceof AssessmentDraftWriteError) {
          return reply.code(502).send({
            error: `${error.message} ${error.savedQuestionCount} of the requested questions were saved. The assessment remains unpublished; use ID ${error.assessmentId} to identify the partial draft.`
          })
        }
        return handleError(reply, error)
      }
    }
  )
  app.post<{ Params: { assessmentId: string } }>(
    '/api/admin/assessments/:assessmentId/publish',
    async (request, reply) => {
      try {
        if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
        auth.authorizeAdmin(bearerToken(request.headers.authorization))
        if (!isBoundedString(request.params.assessmentId)) {
          return reply.code(400).send({ error: 'Assessment ID is invalid.' })
        }
        await service.publishAssessmentDraft(request.params.assessmentId)
        return { assessmentId: request.params.assessmentId, published: true }
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.get<{
    Params: { attemptId: string }
    Querystring: { assessmentId?: string }
  }>('/api/admin/attempts/:attemptId/insights', async (request, reply) => {
    let events
    try {
      if (!auth)
        return reply
          .code(401)
          .send({ status: 'failed', message: 'Authentication is invalid or expired.' })
      auth.authorizeAdmin(bearerToken(request.headers.authorization))
      const { attemptId } = request.params
      const assessmentId = request.query.assessmentId
      if (!isBoundedString(attemptId) || !isBoundedString(assessmentId)) {
        return reply
          .code(400)
          .send({ status: 'failed', message: 'Attempt or assessment ID is invalid.' })
      }
      if (!insightProvider) {
        return {
          status: 'not_configured',
          message:
            'Configure PEARL_PROCTORING_LLM_API_KEY and PEARL_PROCTORING_LLM_MODEL in the backend environment to enable AI summaries.'
        }
      }
      if (!service.hasActivityLog()) {
        return reply.code(503).send({
          status: 'failed',
          message: 'Activity event storage is not configured.'
        })
      }
      events = await service.listActivityEvents(attemptId, assessmentId)
    } catch (error) {
      return handleError(reply, error)
    }
    try {
      return await insightProvider.summarize(events)
    } catch (error) {
      return reply.code(503).send({
        status: 'failed',
        message:
          error instanceof Error
            ? error.message.slice(0, 180)
            : 'AI summary is unavailable. Recorded event evidence remains available.'
      })
    }
  })
  app.post<{ Body: { action?: string; targetId?: string } }>(
    '/api/admin/audit',
    async (request, reply) => {
      try {
        if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
        const identity = auth.authorizeAdmin(bearerToken(request.headers.authorization))
        if (
          !adminAuditStore ||
          !isRecord(request.body) ||
          request.body.action !== 'report_export' ||
          (request.body.targetId !== 'attempts' && request.body.targetId !== 'events')
        ) {
          return reply
            .code(400)
            .send({ error: 'Invalid or unavailable administrator audit action.' })
        }
        adminAuditStore.record(identity.email, 'report_export', request.body.targetId)
        return reply.code(202).send({ recorded: true })
      } catch (error) {
        if (error instanceof AdminAuditStorageError) {
          return reply.code(503).send({
            error:
              'Administrator audit storage is unavailable; the report export was not authorized.'
          })
        }
        return handleError(reply, error)
      }
    }
  )
  app.post('/api/admin/auth/logout', async (request, reply) => {
    try {
      if (!auth) return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
      auth.authorizeAdmin(bearerToken(request.headers.authorization))
      auth.logout(bearerToken(request.headers.authorization))
      return { ok: true }
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.post<{
    Params: { attemptId: string }
    Body: {
      assessmentId?: string
      type?: string
      hostname?: string
      fromHostname?: string
      url?: string
      query?: string
      observationCount?: number
      observationDurationMs?: number
      confidence?: number
    }
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
      const recorded = await service.recordActivityEvent(
        request.params.attemptId,
        request.body.assessmentId,
        event
      )
      return reply.code(202).send({ accepted: true, event: recorded })
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.get<{
    Params: { attemptId: string }
    Querystring: { assessmentId?: string }
  }>('/api/attempts/:attemptId/proctoring-insights', async (request, reply) => {
    try {
      const assessmentId = request.query.assessmentId
      if (!auth || !isBoundedString(request.params.attemptId) || !isBoundedString(assessmentId)) {
        return reply
          .code(401)
          .send({ status: 'failed', message: 'Authentication is invalid or expired.' })
      }
      const credential = bearerToken(request.headers.authorization)
      auth.authorizeAttempt(credential, assessmentId, request.params.attemptId)
      const events = await service.listActivityEvents(request.params.attemptId, assessmentId)
      if (!insightProvider) {
        return {
          status: 'not_configured',
          message:
            'Configure PEARL_PROCTORING_LLM_API_KEY and PEARL_PROCTORING_LLM_MODEL in the backend environment to enable AI summaries.'
        }
      }
      try {
        return await insightProvider.summarize(events)
      } catch (error) {
        return reply.code(503).send({
          status: 'failed',
          message:
            error instanceof Error
              ? error.message.slice(0, 180)
              : 'AI summary is unavailable. Deterministic review rules remain active.'
        })
      }
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
        const assessment = await service.getPublishedAssessment(request.params.assessmentId)
        const { questions, ...metadata } = assessment
        const { recordId, ...publicMetadata } = metadata
        void recordId
        return { assessment: { ...publicMetadata, questionCount: questions.length } }
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.get<{ Params: { assessmentId: string } }>(
    '/api/assessments/:assessmentId/questions',
    async (request, reply) => {
      try {
        if (!auth || !isBoundedString(request.params.assessmentId)) {
          return reply.code(401).send({ error: 'Authentication is invalid or expired.' })
        }
        const identity = auth.authorize(
          bearerToken(request.headers.authorization),
          request.params.assessmentId
        )
        const assessment = await service.getPublishedAssessment(identity.assessmentId)
        return { questions: assessment.questions }
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
          auth && credential
            ? auth.reserveAttemptCreation(credential, request.params.assessmentId)
            : undefined
        try {
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
          if (identity) auth!.releaseAttemptCreation(credential)
          throw error
        }
      } catch (error) {
        return handleError(reply, error)
      }
    }
  )
  app.post<{
    Params: { attemptId: string }
    Body: { assessmentId?: string; answers?: unknown; trigger?: string }
  }>('/api/attempts/:attemptId/submissions', async (request, reply) => {
    try {
      if (
        !isBoundedString(request.params.attemptId) ||
        !isRecord(request.body) ||
        typeof request.body.assessmentId !== 'string'
      ) {
        return reply.code(400).send({ error: 'Invalid submission request.' })
      }
      if (request.body.trigger !== undefined && request.body.trigger !== 'deadline') {
        return reply.code(400).send({ error: 'Invalid submission trigger.' })
      }
      const credential = bearerToken(request.headers.authorization)
      if (auth && credential)
        auth.authorizeAttempt(credential, request.body.assessmentId, request.params.attemptId)
      return await service.submit(
        request.params.attemptId,
        request.body.assessmentId,
        request.body.answers,
        auth && credential ? undefined : credential,
        Boolean(auth && credential),
        request.body.trigger
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

function logAuthenticationFailure(stage: string, reason: string): void {
  console.warn(`[auth] stage=${stage} reason=${reason}`)
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
  if (error instanceof AirtableRequestError) {
    const code = error.errorType ? ` ${error.errorType}` : ''
    const detail = `Airtable rejected the request (HTTP ${error.status}${code}): ${error.safeMessage}`
    if (error.status === 401 || error.status === 403) {
      return reply.code(502).send({
        error: `${detail} Check that AIRTABLE_PAT is valid, can access this base, and has data.records:read and data.records:write permissions.`
      })
    }
    if (error.status === 404) {
      return reply.code(502).send({
        error: `${detail} Check AIRTABLE_BASE_ID and the configured Assessments, Questions, and Attempts table names.`
      })
    }
    if (
      /invalid_multiple_choice_options|multiple choice options|new select option|select option/i.test(
        error.safeMessage
      ) ||
      error.errorType === 'INVALID_MULTIPLE_CHOICE_OPTIONS'
    ) {
      return reply.code(502).send({
        error: `${detail} Set the Attempts.Status field in Airtable to a Single select with exactly the option values in_progress, submitted, and expired.`
      })
    }
    if (
      /unknown field|field .*not found/i.test(error.safeMessage) &&
      /ParticipantEmail/i.test(error.safeMessage)
    ) {
      return reply.code(502).send({
        error: `${detail} Add a single-line text field named exactly ParticipantEmail to the configured Attempts table, then retry. See docs/AIRTABLE_SETUP.md.`
      })
    }
    if (/unknown field|field .*not found/i.test(error.safeMessage)) {
      return reply.code(502).send({
        error: `${detail} Match the configured table fields to docs/AIRTABLE_SETUP.md.`
      })
    }
    return reply.code(502).send({ error: detail })
  }
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
  for (const key of ['hostname', 'fromHostname', 'url', 'query'] as const) {
    const field = value[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > 512)) {
      throw new ValidationError('Audit event payload is invalid.')
    }
    if (typeof field === 'string' && field.length > 0) {
      event[key] = sanitizeAuditField(key, field)
    }
  }
  if (value.observationCount !== undefined) {
    if (
      !Number.isInteger(value.observationCount) ||
      Number(value.observationCount) < 1 ||
      Number(value.observationCount) > 100
    ) {
      throw new ValidationError('Audit observation count is invalid.')
    }
    event.observationCount = Number(value.observationCount)
  }
  if (value.observationDurationMs !== undefined) {
    if (
      !Number.isInteger(value.observationDurationMs) ||
      Number(value.observationDurationMs) < 0 ||
      Number(value.observationDurationMs) > 600_000
    ) {
      throw new ValidationError('Audit observation duration is invalid.')
    }
    event.observationDurationMs = Number(value.observationDurationMs)
  }
  if (value.confidence !== undefined) {
    if (
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1
    ) {
      throw new ValidationError('Audit confidence is invalid.')
    }
    event.confidence = value.confidence
  }
  return event
}

function sanitizeAuditField(
  key: 'hostname' | 'fromHostname' | 'url' | 'query',
  value: string
): string {
  if (key === 'query') {
    return value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\b(password|passcode|secret|token|otp|code)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .slice(0, 256)
  }
  try {
    const parsed = new URL(value)
    return key === 'hostname' || key === 'fromHostname'
      ? parsed.hostname.toLowerCase()
      : `${parsed.origin}${parsed.pathname}`
  } catch {
    if ((key === 'hostname' || key === 'fromHostname') && /^[a-z0-9.-]+$/i.test(value)) {
      return value.toLowerCase()
    }
    throw new ValidationError('Audit event URL is invalid.')
  }
}

function bearerToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length).trim()
  return token || undefined
}
