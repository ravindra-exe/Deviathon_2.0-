import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { AssessmentService } from './service'
import type { OtpDelivery } from './mailer'

export interface AuthIdentity {
  email: string
  participantId: string
  assessmentId: string
  sessionId: string
  expiresAt: string
  role: 'participant' | 'administrator'
}
export interface AuthSession extends AuthIdentity {
  token: string
}

interface OtpRecord {
  email: string
  assessmentId: string
  digest: Buffer
  expiresAt: number
  attempts: number
  lastIssuedAt: number
}

interface SessionRecord extends AuthIdentity {
  tokenDigest: Buffer
  attemptId?: string
  attemptCreationPending?: boolean
}

export class AuthError extends Error {
  constructor(
    readonly code:
      'invalid' | 'unauthorized' | 'rate_limit' | 'configuration' | 'expired' | 'conflict',
    message: string,
    readonly diagnosticReason?: string
  ) {
    super(message)
  }
}

const ADMIN_SCOPE = '__pearl_admin__'

export class OtpAuthService {
  private readonly otps = new Map<string, OtpRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly emailRequests = new Map<string, number[]>()
  private readonly ipRequests = new Map<string, number[]>()

  constructor(
    private readonly assessmentService: AssessmentService,
    private readonly delivery: OtpDelivery,
    private readonly secret: string,
    private readonly clock: () => number = Date.now,
    adminEmails: readonly string[] = []
  ) {
    this.adminEmails = new Set(adminEmails.map(normalizeEmail).filter(isEmail))
    if (!secret.trim())
      throw new AuthError('configuration', 'OTP authentication is not configured.')
  }

  private readonly adminEmails: ReadonlySet<string>

  async requestOtp(emailInput: string, assessmentId: string, ip: string): Promise<void> {
    const email = normalizeEmail(emailInput)
    if (!isEmail(email) || !isIdentifier(assessmentId))
      throw new AuthError('invalid', 'Invalid authentication request.', 'invalid_request')
    await this.assessmentService.getPublishedAssessment(assessmentId)
    await this.issueOtp(email, assessmentId, ip)
  }

  async requestAdminOtp(emailInput: string, ip: string): Promise<void> {
    const email = normalizeEmail(emailInput)
    this.checkRate(this.ipRequests, ip)
    if (!isEmail(email)) {
      this.recordRate(this.ipRequests, ip)
      throw new AuthError('invalid', 'Enter a valid administrator email address.')
    }
    this.checkRate(this.emailRequests, email)
    if (!this.adminEmails.has(email)) {
      this.recordRate(this.emailRequests, email)
      this.recordRate(this.ipRequests, ip)
      throw new AuthError(
        'unauthorized',
        'This email address is not authorized for the Admin Console.',
        'admin_not_allowed'
      )
    }
    await this.issueOtp(email, ADMIN_SCOPE, ip)
  }

  private async issueOtp(email: string, assessmentId: string, ip: string): Promise<void> {
    this.cleanup()
    this.checkRate(this.emailRequests, email)
    this.checkRate(this.ipRequests, ip)
    const existing = this.otps.get(this.otpKey(email, assessmentId))
    const now = this.clock()
    if (existing && now - existing.lastIssuedAt < 60_000)
      throw new AuthError('rate_limit', 'Too many authentication requests.')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const record: OtpRecord = {
      email,
      assessmentId,
      digest: this.digest(code),
      expiresAt: now + 5 * 60_000,
      attempts: 0,
      lastIssuedAt: now
    }
    this.otps.set(this.otpKey(email, assessmentId), record)
    this.recordRate(this.emailRequests, email)
    this.recordRate(this.ipRequests, ip)
    try {
      await this.delivery.send({ email, assessmentId, code, expiresAt: new Date(record.expiresAt) })
    } catch {
      this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError(
        'configuration',
        'Authentication delivery is unavailable.',
        'mail_delivery_failed'
      )
    }
  }

  verifyOtp(emailInput: string, assessmentId: string, code: string): AuthSession {
    return this.verifyScopedOtp(emailInput, assessmentId, code, 'participant')
  }

  verifyAdminOtp(emailInput: string, code: string): AuthSession {
    const email = normalizeEmail(emailInput)
    if (!isEmail(email) || !this.adminEmails.has(email)) {
      throw new AuthError('invalid', 'Authentication failed.', 'admin_not_allowed')
    }
    return this.verifyScopedOtp(email, ADMIN_SCOPE, code, 'administrator')
  }

  private verifyScopedOtp(
    emailInput: string,
    assessmentId: string,
    code: string,
    role: AuthIdentity['role']
  ): AuthSession {
    const email = normalizeEmail(emailInput)
    const record = this.otps.get(this.otpKey(email, assessmentId))
    if (!record) {
      throw new AuthError('invalid', 'Authentication failed.', 'challenge_missing')
    }
    if (!/^\d{6}$/.test(code)) {
      throw new AuthError('invalid', 'Authentication failed.', 'malformed_code')
    }
    if (this.clock() >= record.expiresAt) {
      this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError('invalid', 'Authentication failed.', 'challenge_expired')
    }
    const digest = this.digest(code)
    record.attempts += 1
    if (record.attempts > 5) {
      this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError('invalid', 'Authentication failed.', 'attempt_limit')
    }
    if (!timingSafeEqual(record.digest, digest)) {
      if (record.attempts >= 5) this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError(
        'invalid',
        'Authentication failed.',
        record.attempts >= 5 ? 'attempt_limit' : 'code_mismatch'
      )
    }
    this.cleanup()
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.email === email &&
          session.assessmentId === assessmentId &&
          session.role === role &&
          this.clock() < Date.parse(session.expiresAt)
      )
    ) {
      this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError(
        'conflict',
        'An active assessment session already exists for this account.',
        'active_session'
      )
    }
    this.otps.delete(this.otpKey(email, assessmentId))
    const token = randomBytes(32).toString('base64url')
    const sessionId = randomBytes(16).toString('hex')
    const expiresAt = new Date(this.clock() + 60 * 60_000).toISOString()
    const identity: AuthIdentity = {
      email,
      participantId: `email-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
      assessmentId,
      sessionId,
      expiresAt,
      role
    }
    try {
      this.sessions.set(sessionId, { ...identity, tokenDigest: this.digest(token) })
    } catch {
      throw new AuthError(
        'configuration',
        'Authentication session could not be created.',
        'session_creation_failed'
      )
    }
    return { ...identity, token }
  }

  authorize(value: string | undefined, assessmentId: string): AuthIdentity {
    const [id, token] = value?.split('.') ?? []
    const record = id ? this.sessions.get(id) : undefined
    if (
      !record ||
      (assessmentId && record.assessmentId !== assessmentId) ||
      this.clock() >= Date.parse(record.expiresAt) ||
      !token ||
      !timingSafeEqual(record.tokenDigest, this.digest(token))
    ) {
      throw new AuthError('invalid', 'Authentication is invalid or expired.')
    }

    return { ...record }
  }

  session(value: string | undefined): AuthIdentity {
    return this.authorize(value, '')
  }

  authorizeAdmin(value: string | undefined): AuthIdentity {
    const identity = this.authorize(value, ADMIN_SCOPE)
    if (identity.role !== 'administrator' || !this.adminEmails.has(identity.email)) {
      throw new AuthError('invalid', 'Authentication is invalid or expired.')
    }
    return identity
  }

  logout(value: string | undefined): void {
    const [id] = value?.split('.') ?? []
    if (id) this.sessions.delete(id)
  }

  bindAttempt(value: string | undefined, attemptId: string): AuthIdentity {
    const [id] = value?.split('.') ?? []
    const record = id ? this.sessions.get(id) : undefined
    if (!record) throw new AuthError('invalid', 'Authentication is invalid or expired.')
    if (record.attemptId && record.attemptId !== attemptId) {
      throw new AuthError('conflict', 'This session is already bound to an assessment attempt.')
    }
    record.attemptId = attemptId
    record.attemptCreationPending = false
    return { ...record }
  }

  reserveAttemptCreation(value: string | undefined, assessmentId: string): AuthIdentity {
    const identity = this.authorize(value, assessmentId)
    const record = this.sessions.get(identity.sessionId)
    if (!record || record.attemptId || record.attemptCreationPending) {
      throw new AuthError(
        'conflict',
        'This session already has an assessment attempt.',
        'attempt_already_bound'
      )
    }
    record.attemptCreationPending = true
    return identity
  }

  releaseAttemptCreation(value: string | undefined): void {
    const [id] = value?.split('.') ?? []
    const record = id ? this.sessions.get(id) : undefined
    if (record && !record.attemptId) record.attemptCreationPending = false
  }

  authorizeAttempt(
    value: string | undefined,
    assessmentId: string,
    attemptId: string
  ): AuthIdentity {
    const identity = this.authorize(value, assessmentId)
    const [id] = value?.split('.') ?? []
    const record = id ? this.sessions.get(id) : undefined
    if (!record || record.attemptId !== attemptId)
      throw new AuthError('invalid', 'Authentication is invalid or expired.')
    return identity
  }

  private digest(value: string): Buffer {
    return createHash('sha256').update(this.secret).update(value).digest()
  }
  private otpKey(email: string, assessmentId: string): string {
    return `${email}:${assessmentId}`
  }
  private checkRate(map: Map<string, number[]>, key: string): void {
    const now = this.clock()
    const values = (map.get(key) ?? []).filter((value) => now - value < 60 * 60_000)
    map.set(key, values)
    if (values.length >= 5) throw new AuthError('rate_limit', 'Too many authentication requests.')
  }
  private recordRate(map: Map<string, number[]>, key: string): void {
    map.set(key, [...(map.get(key) ?? []), this.clock()])
  }
  private cleanup(): void {
    const now = this.clock()
    for (const [key, record] of this.otps) if (now >= record.expiresAt) this.otps.delete(key)
    for (const [key, record] of this.sessions)
      if (now >= Date.parse(record.expiresAt)) this.sessions.delete(key)
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}
function isIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128
}
