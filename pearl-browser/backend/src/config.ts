export interface BackendConfig {
  port: number
  airtablePat: string
  baseId: string
  assessmentsTable: string
  questionsTable: string
  attemptsTable: string
  otpSecret: string
  smtp: { host: string; port: number; user: string; pass: string; from: string; secure: boolean }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const required = {
    airtablePat: env.AIRTABLE_PAT,
    baseId: env.AIRTABLE_BASE_ID,
    assessmentsTable: env.AIRTABLE_ASSESSMENTS_TABLE,
    questionsTable: env.AIRTABLE_QUESTIONS_TABLE,
    attemptsTable: env.AIRTABLE_ATTEMPTS_TABLE
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(
      `Missing backend configuration: ${missing.join(', ')}. ` +
        'Create pearl-browser/.env from pearl-browser/.env.example and fill in the Airtable values.'
    )
  }
  const security = {
    otpSecret: env.PEARL_OTP_SECRET,
    smtpHost: env.SMTP_HOST,
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    smtpFrom: env.SMTP_FROM
  }
  const missingSecurity = Object.entries(security)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key)
  if (missingSecurity.length > 0) {
    throw new Error(`Missing OTP/SMTP configuration: ${missingSecurity.join(', ')}.`)
  }
  if (env.NODE_ENV === 'production' && security.otpSecret!.trim().length < 32) {
    throw new Error('PEARL_OTP_SECRET must be at least 32 characters in production.')
  }
  const smtpPort = Number(env.SMTP_PORT ?? 587)
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535)
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.')
  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }
  return {
    airtablePat: required.airtablePat!,
    baseId: required.baseId!,
    assessmentsTable: required.assessmentsTable!,
    questionsTable: required.questionsTable!,
    attemptsTable: required.attemptsTable!,
    port,
    otpSecret: security.otpSecret!,
    smtp: {
      host: security.smtpHost!,
      port: smtpPort,
      user: security.smtpUser!,
      pass: security.smtpPass!,
      from: security.smtpFrom!,
      secure: env.SMTP_SECURE === 'true'
    }
  }
}
