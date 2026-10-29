import { describe, expect, it } from 'vitest'
import {
  evaluateAssessmentNavigation,
  validateAssessmentPolicy
} from '../src/main/browser/AssessmentNavigationPolicy'
import type { AssessmentPolicy } from '../src/shared/assessment'

const policy: AssessmentPolicy = {
  allowedHosts: ['exam.example.com'],
  blockedHosts: ['blocked.example.com'],
  allowSubdomains: true,
  localDevelopmentHosts: ['127.0.0.1'],
  allowHttpLocalDevelopment: true,
  allowNewTabs: false,
  allowPopupDestinations: false,
  activeTabOnly: true,
  allowLeavingAssessment: false,
  durationMinutes: 10,
  recordHistory: false,
  warningOnRestrictedAction: true,
  expirationBehavior: 'submit',
  cancellationBehavior: 'return-to-browser'
}

describe('AssessmentNavigationPolicy', () => {
  it('allows the configured HTTPS host and legitimate subdomains', () => {
    expect(evaluateAssessmentNavigation('https://exam.example.com', policy).allowed).toBe(true)
    expect(evaluateAssessmentNavigation('https://portal.exam.example.com', policy).allowed).toBe(
      true
    )
  })

  it('rejects malicious suffixes and substring matches', () => {
    expect(
      evaluateAssessmentNavigation('https://exam.example.com.attacker.test', policy).allowed
    ).toBe(false)
    expect(evaluateAssessmentNavigation('https://notexam.example.com', policy).allowed).toBe(false)
  })

  it('rejects HTTP and unsupported protocols except explicit local development', () => {
    expect(evaluateAssessmentNavigation('http://exam.example.com', policy).reason).toBe(
      'unsupported-protocol'
    )
    expect(evaluateAssessmentNavigation('http://127.0.0.1:3000', policy).allowed).toBe(true)
    expect(evaluateAssessmentNavigation('file:///tmp/exam', policy).reason).toBe(
      'unsupported-protocol'
    )
  })

  it('fails closed for malformed URLs and empty allowlists', () => {
    expect(evaluateAssessmentNavigation('not a url', policy).reason).toBe('invalid-url')
    expect(
      evaluateAssessmentNavigation('https://example.com', {
        ...policy,
        allowedHosts: [],
        localDevelopmentHosts: [],
        allowHttpLocalDevelopment: false
      }).reason
    ).toBe('host-not-allowed')
  })

  it('rejects new tabs and popup destinations by policy', () => {
    expect(
      evaluateAssessmentNavigation('https://exam.example.com', policy, { newTab: true }).reason
    ).toBe('new-tab-not-allowed')
    expect(
      evaluateAssessmentNavigation('https://exam.example.com', policy, { popup: true }).reason
    ).toBe('popup-not-allowed')
  })

  it('validates unsafe policy configuration', () => {
    expect(() =>
      validateAssessmentPolicy({
        ...policy,
        allowHttpLocalDevelopment: true,
        localDevelopmentHosts: []
      })
    ).toThrow()
    expect(() =>
      validateAssessmentPolicy({ ...policy, allowedHosts: ['exam.example.com/route'] })
    ).toThrow()
  })
})
