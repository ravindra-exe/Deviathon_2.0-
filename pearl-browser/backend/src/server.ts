import { config as loadDotenv } from 'dotenv'
import { join } from 'node:path'
import { HttpAirtableClient } from './airtable'
import { createApp } from './app'
import { loadConfig } from './config'
import { AssessmentService } from './service'
import { EnrollmentTokenStore } from './enrollment'
import { OtpAuthService } from './auth'
import { SmtpOtpDelivery } from './mailer'
import { AdminActionAuditStore, AssessmentAuditStore } from './audit'
import {
  GeminiProctoringInsightProvider,
  OpenAIProctoringInsightProvider
} from './proctoringInsights'
import { AssessmentDraftRegistry } from './questionDraftRegistry'
import {
  GeminiQuestionGenerationProvider,
  OpenAIQuestionGenerationProvider
} from './questionGeneration'

loadDotenv({ path: join(process.cwd(), '.env'), quiet: true })

const config = loadConfig()
const adminEmails = (process.env.PEARL_ADMIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)
const enrollment = new EnrollmentTokenStore(
  process.env.NODE_ENV !== 'production' && process.env.DEV_ENROLLMENT_ENABLED === 'true'
)
const auditStore = new AssessmentAuditStore(
  process.env.PEARL_AUDIT_LOG_PATH || join(process.cwd(), 'backend-data', 'proctoring-events.jsonl')
)
const adminAuditStore = new AdminActionAuditStore(
  process.env.PEARL_ADMIN_AUDIT_LOG_PATH ||
    join(process.cwd(), 'backend-data', 'admin-actions.jsonl')
)
const service = new AssessmentService(
  new HttpAirtableClient(config.airtablePat, config.baseId),
  {
    assessments: config.assessmentsTable,
    questions: config.questionsTable,
    attempts: config.attemptsTable
  },
  enrollment,
  auditStore,
  new AssessmentDraftRegistry(
    process.env.PEARL_QUESTION_DRAFT_REGISTRY_PATH ||
      join(process.cwd(), 'backend-data', 'question-generator-drafts.jsonl')
  )
)
const proctoringApiKey = process.env.PEARL_PROCTORING_LLM_API_KEY?.trim()
const proctoringModel = process.env.PEARL_PROCTORING_LLM_MODEL?.trim()
const usesGemini = proctoringModel?.toLowerCase().startsWith('gemini-') ?? false
const proctoringInsightProvider =
  proctoringApiKey && proctoringModel
    ? usesGemini
      ? new GeminiProctoringInsightProvider(proctoringApiKey, proctoringModel)
      : new OpenAIProctoringInsightProvider(proctoringApiKey, proctoringModel)
    : undefined
const questionGenerationApiKey = process.env.PEARL_PROCTORING_LLM_API_KEY?.trim()
const questionGenerationModel = process.env.PEARL_PROCTORING_LLM_MODEL?.trim()
const questionGenerationProvider =
  questionGenerationApiKey && questionGenerationModel
    ? usesGemini
      ? new GeminiQuestionGenerationProvider(questionGenerationApiKey, questionGenerationModel)
      : new OpenAIQuestionGenerationProvider(questionGenerationApiKey, questionGenerationModel)
    : undefined
const app = createApp(
  service,
  new OtpAuthService(
    service,
    new SmtpOtpDelivery(config.smtp),
    config.otpSecret,
    Date.now,
    adminEmails
  ),
  proctoringInsightProvider,
  adminAuditStore,
  questionGenerationProvider
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
