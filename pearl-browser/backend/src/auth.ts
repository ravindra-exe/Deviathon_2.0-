import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { AssessmentService } from './service'
import type { OtpDelivery } from './mailer'

export interface AuthIdentity {
  email: string
  participantId: string
  assessmentId: string
  sessionId: string
  expiresAt: string
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
}

export class AuthError extends Error {
  constructor(
    readonly code: 'invalid' | 'rate_limit' | 'configuration' | 'expired',
    message: string
  ) {
    super(message)
  }
}

export class OtpAuthService {
  private readonly otps = new Map<string, OtpRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly emailRequests = new Map<string, number[]>()
  private readonly ipRequests = new Map<string, number[]>()

  constructor(
    private readonly assessmentService: AssessmentService,
    private readonly delivery: OtpDelivery,
    private readonly secret: string,
    private readonly clock: () => number = Date.now
  ) {
    if (!secret.trim())
      throw new AuthError('configuration', 'OTP authentication is not configured.')
  }

  async requestOtp(emailInput: string, assessmentId: string, ip: string): Promise<void> {
    const email = normalizeEmail(emailInput)
    if (!isEmail(email) || !isIdentifier(assessmentId))
      throw new AuthError('invalid', 'Invalid authentication request.')
    await this.assessmentService.getPublishedAssessment(assessmentId)
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
      throw new AuthError('configuration', 'Authentication delivery is unavailable.')
    }
  }

  verifyOtp(emailInput: string, assessmentId: string, code: string): AuthSession {
    const email = normalizeEmail(emailInput)
    const record = this.otps.get(this.otpKey(email, assessmentId))
    if (!record || !/^\d{6}$/.test(code) || this.clock() >= record.expiresAt) {
      throw new AuthError('invalid', 'Authentication failed.')
    }
    const digest = this.digest(code)
    record.attempts += 1
    if (record.attempts > 5 || !timingSafeEqual(record.digest, digest)) {
      if (record.attempts >= 5) this.otps.delete(this.otpKey(email, assessmentId))
      throw new AuthError('invalid', 'Authentication failed.')
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
      expiresAt
    }
    this.sessions.set(sessionId, { ...identity, tokenDigest: this.digest(token) })
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

  logout(value: string | undefined): void {
    const [id] = value?.split('.') ?? []
    if (id) this.sessions.delete(id)
  }

  bindAttempt(value: string | undefined, attemptId: string): AuthIdentity {
    const [id] = value?.split('.') ?? []
    const record = id ? this.sessions.get(id) : undefined
    if (!record) throw new AuthError('invalid', 'Authentication is invalid or expired.')
    ;(record as SessionRecord & { attemptId?: string }).attemptId = attemptId
    return { ...record }
  }

  authorizeAttempt(
    value: string | undefined,
    assessmentId: string,
    attemptId: string
  ): AuthIdentity {
    const identity = this.authorize(value, assessmentId)
    const [id] = value?.split('.') ?? []
    const record = id
      ? (this.sessions.get(id) as (SessionRecord & { attemptId?: string }) | undefined)
      : undefined
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
