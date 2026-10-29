import { describe, expect, it, vi } from 'vitest'
import {
  EnrollmentAuthorizationError,
  EnrollmentDisabledError,
  EnrollmentTokenStore
} from '../src/enrollment'

describe('development enrollment tokens', () => {
  it('issues a short-lived single-attempt token', () => {
    const store = new EnrollmentTokenStore(true, 1_000)
    const issued = store.issue('assessment-1')
    expect(issued.token.length).toBeGreaterThan(32)
    store.bindAttempt(issued.token, 'assessment-1', 'attempt-1')
    expect(() => store.bindAttempt(issued.token, 'assessment-1', 'attempt-2')).toThrow(
      EnrollmentAuthorizationError
    )
    expect(() => store.authorize(issued.token, 'assessment-1', 'attempt-1')).not.toThrow()
  })

  it('rejects invalid, unauthorized, expired, and disabled tokens', () => {
    vi.useFakeTimers()
    try {
      const store = new EnrollmentTokenStore(true, 1)
      const issued = store.issue('assessment-1')
      expect(() => store.authorize('invalid', 'assessment-1', 'attempt-1')).toThrow(
        EnrollmentAuthorizationError
      )
      expect(() => store.bindAttempt(issued.token, 'other-assessment', 'attempt-1')).toThrow(
        EnrollmentAuthorizationError
      )
      vi.advanceTimersByTime(2)
      expect(() => store.authorize(issued.token, 'assessment-1', 'attempt-1')).toThrow(
        EnrollmentAuthorizationError
      )
      const disabled = new EnrollmentTokenStore(false)
      expect(() => disabled.issue('assessment-1')).toThrow(EnrollmentDisabledError)
    } finally {
      vi.useRealTimers()
    }
  })
})
