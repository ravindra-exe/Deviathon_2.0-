import { config as loadDotenv } from 'dotenv'
import { join } from 'node:path'
import { AirtableRequestError, AirtableResponseError, HttpAirtableClient } from '../src/airtable'
import { loadConfig } from '../src/config'
import {
  AssessmentService,
  NotFoundError,
  parseQuestionOptions,
  ValidationError
} from '../src/service'

const assessmentId = 'pearl-demo-001'

loadDotenv({ path: join(process.cwd(), '.env'), quiet: true })

async function run(): Promise<void> {
  const required = [
    'AIRTABLE_PAT',
    'AIRTABLE_BASE_ID',
    'AIRTABLE_ASSESSMENTS_TABLE',
    'AIRTABLE_QUESTIONS_TABLE',
    'AIRTABLE_ATTEMPTS_TABLE'
  ] as const
  const missing = required.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new SmokeTestError(
      'authentication/configuration',
      `Missing Airtable configuration: ${missing.join(', ')}. ` +
        'Create pearl-browser/.env from pearl-browser/.env.example. ' +
        'Recommended next step: set the missing values and retry.'
    )
  }
  console.log(`Airtable configuration: ${required.map((name) => `${name}=present`).join(', ')}`)

  let config
  try {
    config = loadConfig()
  } catch (error) {
    throw new SmokeTestError(
      'authentication/configuration',
      error instanceof Error ? error.message : 'Invalid Airtable configuration.'
    )
  }
  const airtable = new HttpAirtableClient(config.airtablePat, config.baseId)
  const service = new AssessmentService(airtable, {
    assessments: config.assessmentsTable,
    questions: config.questionsTable,
    attempts: config.attemptsTable
  })

  const assessmentRecords = await runStage('assessment lookup', () =>
    airtable.list(config.assessmentsTable, `{AssessmentId} = '${escapeFormula(assessmentId)}'`)
  )
  const assessment = assessmentRecords[0]
  if (!assessment) {
    throw new SmokeTestError(
      'assessment lookup',
      `Assessment ${assessmentId} was not found. Recommended next step: verify AssessmentId and the assessments table.`
    )
  }
  if (assessment.fields.IsPublished !== true) {
    throw new SmokeTestError(
      'assessment lookup',
      `Assessment ${assessmentId} is not published. Recommended next step: publish the Airtable assessment or use the intended ID.`
    )
  }

  const questionRecords = await runStage('question lookup', () =>
    airtable.list(config.questionsTable, `{AssessmentId} = '${escapeFormula(assessmentId)}'`)
  )
  const activeQuestions = questionRecords.filter((question) => question.fields.IsActive === true)
  if (activeQuestions.length !== 3) {
    throw new SmokeTestError(
      'question lookup',
      `Expected 3 active questions for ${assessmentId}; found ${activeQuestions.length}. Recommended next step: check IsActive and AssessmentId fields.`
    )
  }
  for (const question of activeQuestions) {
    console.log(describeQuestionOptions(question.fields.QuestionId, question.fields.OptionsJSON))
    try {
      parseQuestionOptions(question.fields.OptionsJSON)
    } catch (error) {
      throw new SmokeTestError(
        'response validation',
        error instanceof Error ? error.message : 'Question options are invalid.'
      )
    }
  }

  const publicAssessment = await runStage('response validation', () =>
    service.getPublishedAssessment(assessmentId)
  )
  if (publicAssessment.id !== assessmentId || publicAssessment.questions.length !== 3) {
    throw new SmokeTestError(
      'response validation',
      'The public assessment response does not match the Airtable data. Recommended next step: inspect the configured field names and active-question records.'
    )
  }
  if (JSON.stringify(publicAssessment).includes('CorrectOptionId')) {
    throw new SmokeTestError(
      'response validation',
      'The student-facing assessment response exposes CorrectOptionId. Recommended next step: fix the public mapping before using remote assessment mode.'
    )
  }

  console.log(
    `Airtable read-only smoke test passed: ${assessmentId}, ` +
      `${publicAssessment.questions.length} active questions.`
  )
}

function describeQuestionOptions(questionId: unknown, raw: unknown): string {
  const type = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
  let parsed: unknown
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return `Question ${safeIdentifier(questionId)}: OptionsJSON present=true type=${type} parse=failed`
  }
  const arrayLength = Array.isArray(parsed) ? parsed.length : 'n/a'
  const optionShape =
    Array.isArray(parsed) &&
    parsed.every(
      (option) =>
        typeof option === 'object' &&
        option !== null &&
        typeof (option as Record<string, unknown>).id === 'string' &&
        Boolean((option as Record<string, string>).id.trim()) &&
        typeof (option as Record<string, unknown>).text === 'string' &&
        Boolean((option as Record<string, string>).text.trim())
    )
  return `Question ${safeIdentifier(questionId)}: OptionsJSON present=${raw !== undefined} type=${type} parse=success arrayLength=${arrayLength} optionShape=${optionShape}`
}

function safeIdentifier(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : '<missing>'
}

function escapeFormula(value: string): string {
  return value.replace(/'/g, "\\'")
}

class SmokeTestError extends Error {
  constructor(
    readonly stage: string,
    message: string
  ) {
    super(message)
    this.name = 'SmokeTestError'
  }
}

class StageFailure extends Error {
  constructor(
    readonly stage: string,
    readonly cause: unknown
  ) {
    super(`The ${stage} stage failed.`)
    this.name = 'StageFailure'
  }
}

function describeFailure(error: unknown, stage = 'Airtable request'): string {
  if (error instanceof StageFailure) return describeFailure(error.cause, error.stage)
  if (error instanceof SmokeTestError) {
    return `[${error.stage}] ${error.message}`
  }
  if (error instanceof NotFoundError) {
    return `[${stage}] Schema/configuration mismatch: ${error.message}`
  }
  if (error instanceof ValidationError) {
    return `[${stage}] Schema mismatch: ${error.message} Recommended next step: check the documented Airtable field types and names.`
  }
  if (error instanceof AirtableRequestError) {
    const detail = `${error.errorType ? ` ${error.errorType}:` : ''} ${error.safeMessage}`
    if (error.status === 401) {
      return `[${stage}] HTTP 401${detail} Recommended next step: replace the PAT with a valid token and verify it has access to the base.`
    }
    if (error.status === 403) {
      return `[${stage}] HTTP 403${detail} Recommended next step: grant the PAT record-read access to this base and verify the base restriction.`
    }
    if (error.status === 404) {
      return `[${stage}] HTTP 404${detail} Recommended next step: verify the Base ID and configured table names.`
    }
    if (error.status === 429) {
      return `[${stage}] HTTP 429${detail} Recommended next step: wait and retry after reducing request frequency.`
    }
    return `[${stage}] HTTP ${error.status}${detail} Recommended next step: check the Airtable API status and configuration.`
  }
  if (error instanceof AirtableResponseError) {
    return `[${stage}] Malformed Airtable response: ${error.message} Recommended next step: retry and check the API response status.`
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('timed out'))
  ) {
    return `[${stage}] Network timeout. Recommended next step: check connectivity and retry.`
  }
  if (error instanceof TypeError) {
    return `[${stage}] Network or TLS failure. Recommended next step: verify HTTPS connectivity to api.airtable.com.`
  }
  return `[${stage}] Smoke test failed unexpectedly. Recommended next step: retry and inspect the local error output.`
}

async function runStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SmokeTestError) throw error
    throw new StageFailure(stage, error)
  }
}

run().catch((error: unknown) => {
  console.error(describeFailure(error))
  process.exitCode = 1
})
