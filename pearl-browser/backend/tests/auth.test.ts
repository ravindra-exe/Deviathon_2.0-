import { describe, expect, it } from 'vitest'
import { AuthError, OtpAuthService } from '../src/auth'
import type { OtpDelivery, OtpMessage } from '../src/mailer'

class Mailbox implements OtpDelivery {
  messages: OtpMessage[] = []
  async send(message: OtpMessage): Promise<void> {
    this.messages.push(message)
  }
}

class FailingMailbox implements OtpDelivery {
  async send(): Promise<void> {
    throw new Error('SMTP unavailable')
  }
}

function create(
  clock: { value: number },
  mailbox: OtpDelivery = new Mailbox(),
  adminEmails: string[] = []
): OtpAuthService {
  const assessmentService = {
    getPublishedAssessment: async (id: string) => {
      if (id !== 'pearl-demo-001') throw new Error('not found')
      return {} as never
    }
  }
  return new OtpAuthService(
    assessmentService as never,
    mailbox,
    'test-secret',
    () => clock.value,
    adminEmails
  )
}

describe('OTP authentication', () => {
  it('normalizes email, verifies once, and issues a session', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox)
    await auth.requestOtp(' Participant@Example.com ', 'pearl-demo-001', '127.0.0.1')
    const session = auth.verifyOtp(
      'participant@example.com',
      'pearl-demo-001',
      mailbox.messages[0].code
    )
    expect(session.email).toBe('participant@example.com')
    expect(auth.session(`${session.sessionId}.${session.token}`).participantId).toMatch(/^email-/)
    expect(() =>
      auth.verifyOtp('participant@example.com', 'pearl-demo-001', mailbox.messages[0].code)
    ).toThrow(expect.objectContaining({ diagnosticReason: 'challenge_missing' }))
  })

  it('only issues administrator sessions after OTP verification for an allowlisted email', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox, ['admin@example.com'])
    await expect(auth.requestAdminOtp('other@example.com', 'ip')).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(mailbox.messages).toHaveLength(0)
    await auth.requestAdminOtp(' ADMIN@example.com ', 'ip')
    expect(mailbox.messages).toHaveLength(1)
    const session = auth.verifyAdminOtp('admin@example.com', mailbox.messages[0].code)
    const credential = `${session.sessionId}.${session.token}`
    expect(auth.authorizeAdmin(credential).role).toBe('administrator')
    expect(() => auth.authorizeAdmin(undefined)).toThrow(AuthError)
    expect(() => auth.verifyAdminOtp('other@example.com', mailbox.messages[0].code)).toThrow(
      AuthError
    )
  })

  it('rejects expired and incorrect codes', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox)
    await auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')
    expect(() => auth.verifyOtp('a@example.com', 'pearl-demo-001', '000000')).toThrow(
      expect.objectContaining({ diagnosticReason: 'code_mismatch' })
    )
    clock.value += 5 * 60_000
    expect(() =>
      auth.verifyOtp('a@example.com', 'pearl-demo-001', mailbox.messages[0].code)
    ).toThrow(expect.objectContaining({ diagnosticReason: 'challenge_expired' }))
  })

  it('enforces resend cooldown and delivery failures', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox)
    await auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')
    await expect(auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')).rejects.toMatchObject({
      code: 'rate_limit'
    })
    await expect(
      create({ value: 10_000 }, new FailingMailbox()).requestOtp(
        'b@example.com',
        'pearl-demo-001',
        'ip'
      )
    ).rejects.toMatchObject({ code: 'configuration' })
  })

  it('limits requests per email and source IP', async () => {
    const clock = { value: 1_000 }
    const auth = create(clock)
    for (let index = 0; index < 5; index++) {
      clock.value += 60_001
      await auth.requestOtp(`person${index}@example.com`, 'pearl-demo-001', 'same-ip')
    }
    await expect(
      auth.requestOtp('last@example.com', 'pearl-demo-001', 'same-ip')
    ).rejects.toMatchObject({
      code: 'rate_limit'
    })
  })

  it('expires and revokes sessions', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox)
    await auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')
    const session = auth.verifyOtp('a@example.com', 'pearl-demo-001', mailbox.messages[0].code)
    const credential = `${session.sessionId}.${session.token}`
    expect(auth.session(credential).email).toBe('a@example.com')
    auth.logout(credential)
    expect(() => auth.session(credential)).toThrow(AuthError)
  })

  it('rejects concurrent sessions and prevents binding multiple attempts', async () => {
    const clock = { value: 1_000 }
    const mailbox = new Mailbox()
    const auth = create(clock, mailbox)
    await auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')
    const first = auth.verifyOtp('a@example.com', 'pearl-demo-001', mailbox.messages[0].code)
    const firstCredential = `${first.sessionId}.${first.token}`

    clock.value += 60_001
    await auth.requestOtp('a@example.com', 'pearl-demo-001', 'ip')
    expect(() =>
      auth.verifyOtp('a@example.com', 'pearl-demo-001', mailbox.messages[1].code)
    ).toThrow(expect.objectContaining({ code: 'conflict', diagnosticReason: 'active_session' }))

    auth.reserveAttemptCreation(firstCredential, 'pearl-demo-001')
    auth.bindAttempt(firstCredential, 'attempt-1')
    expect(() => auth.reserveAttemptCreation(firstCredential, 'pearl-demo-001')).toThrow(
      expect.objectContaining({ diagnosticReason: 'attempt_already_bound' })
    )
    expect(() => auth.bindAttempt(firstCredential, 'attempt-2')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
  })
})
