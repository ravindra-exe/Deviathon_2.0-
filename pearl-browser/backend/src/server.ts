import { config as loadDotenv } from 'dotenv'
import { join } from 'node:path'
import { HttpAirtableClient } from './airtable'
import { createApp } from './app'
import { loadConfig } from './config'
import { AssessmentService } from './service'
import { EnrollmentTokenStore } from './enrollment'
import { OtpAuthService } from './auth'
import { SmtpOtpDelivery } from './mailer'
import { AssessmentAuditStore } from './audit'
import { OpenAIProctoringInsightProvider } from './proctoringInsights'

loadDotenv({ path: join(process.cwd(), '.env'), quiet: true })

const config = loadConfig()
const enrollment = new EnrollmentTokenStore(
  process.env.NODE_ENV !== 'production' && process.env.DEV_ENROLLMENT_ENABLED === 'true'
)
const auditStore = new AssessmentAuditStore()
const service = new AssessmentService(
  new HttpAirtableClient(config.airtablePat, config.baseId),
  {
    assessments: config.assessmentsTable,
    questions: config.questionsTable,
    attempts: config.attemptsTable
  },
  enrollment,
  auditStore
)
const proctoringInsightProvider =
  process.env.PEARL_PROCTORING_LLM_API_KEY && process.env.PEARL_PROCTORING_LLM_MODEL
    ? new OpenAIProctoringInsightProvider(
        process.env.PEARL_PROCTORING_LLM_API_KEY,
        process.env.PEARL_PROCTORING_LLM_MODEL
      )
    : undefined
const app = createApp(
  service,
  new OtpAuthService(service, new SmtpOtpDelivery(config.smtp), config.otpSecret),
  proctoringInsightProvider
)

app
  .listen({ host: '127.0.0.1', port: config.port })
  .then((address) => {
    console.log(`Pearl assessment backend listening at ${address}`)
  })
  .catch((error: unknown) => {
    app.log.error(error)
    process.exitCode = 1
  })
