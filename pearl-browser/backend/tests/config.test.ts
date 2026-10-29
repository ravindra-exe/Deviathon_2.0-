import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('backend configuration', () => {
  it('reports missing Airtable configuration without exposing values', () => {
    expect(() => loadConfig({})).toThrow('Missing backend configuration')
    expect(() => loadConfig({ AIRTABLE_PAT: 'secret-value' })).toThrowError(
      /baseId|assessmentsTable|questionsTable|attemptsTable/
    )
  })

  it('loads a complete configuration', () => {
    expect(
      loadConfig({
        PORT: '9000',
        AIRTABLE_PAT: 'secret',
        AIRTABLE_BASE_ID: 'app1',
        AIRTABLE_ASSESSMENTS_TABLE: 'Assessments',
        AIRTABLE_QUESTIONS_TABLE: 'Questions',
        AIRTABLE_ATTEMPTS_TABLE: 'Attempts',
        PEARL_OTP_SECRET: 'secret',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_FROM: 'from@example.com'
      })
    ).toMatchObject({ port: 9000, baseId: 'app1' })
  })

  it('rejects a weak OTP secret in production without exposing it', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AIRTABLE_PAT: 'secret',
        AIRTABLE_BASE_ID: 'app1',
        AIRTABLE_ASSESSMENTS_TABLE: 'Assessments',
        AIRTABLE_QUESTIONS_TABLE: 'Questions',
        AIRTABLE_ATTEMPTS_TABLE: 'Attempts',
        PEARL_OTP_SECRET: 'short-secret',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_FROM: 'from@example.com'
      })
    ).toThrow('PEARL_OTP_SECRET must be at least 32 characters in production.')
  })

  it('reports a missing OTP secret without exposing other configuration values', () => {
    expect(() =>
      loadConfig({
        AIRTABLE_PAT: 'secret',
        AIRTABLE_BASE_ID: 'app1',
        AIRTABLE_ASSESSMENTS_TABLE: 'Assessments',
        AIRTABLE_QUESTIONS_TABLE: 'Questions',
        AIRTABLE_ATTEMPTS_TABLE: 'Attempts',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_FROM: 'from@example.com'
      })
    ).toThrow('Missing OTP/SMTP configuration: otpSecret.')
  })
})
