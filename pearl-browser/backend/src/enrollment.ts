import { createHash, randomBytes, randomUUID } from 'node:crypto'

interface EnrollmentRecord {
  tokenHash: string
  assessmentId: string
  expiresAt: number
  attemptId?: string
}

export class EnrollmentTokenStore {
  private readonly records = new Map<string, EnrollmentRecord>()

  constructor(
    private readonly enabled: boolean,
    private readonly lifetimeMs = 5 * 60_000
  ) {}

  issue(assessmentId: string): { token: string; expiresAt: string } {
    this.cleanup()
    if (!this.enabled) throw new EnrollmentDisabledError()
    const token = `${randomUUID()}-${randomBytes(32).toString('base64url')}`
    const expiresAt = Date.now() + this.lifetimeMs
    this.records.set(hashToken(token), { tokenHash: hashToken(token), assessmentId, expiresAt })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  bindAttempt(token: string, assessmentId: string, attemptId: string): void {
    const record = this.require(token, assessmentId)
    if (record.attemptId) throw new EnrollmentAuthorizationError()
    record.attemptId = attemptId
  }

  authorize(token: string, assessmentId: string, attemptId: string): void {
    const record = this.require(token, assessmentId)
    if (record.attemptId !== attemptId) throw new EnrollmentAuthorizationError()
  }

  private require(token: string, assessmentId: string): EnrollmentRecord {
    this.cleanup()
    const record = this.records.get(hashToken(token))
    if (!record || record.assessmentId !== assessmentId) {
      throw new EnrollmentAuthorizationError()
    }

    return record
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key)
    }
  }
}

export class EnrollmentDisabledError extends Error {}
export class EnrollmentAuthorizationError extends Error {}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
