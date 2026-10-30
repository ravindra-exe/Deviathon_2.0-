import { ApiError, GoogleGenAI } from '@google/genai'

export type QuestionDifficulty = 'Easy' | 'Medium' | 'Hard'

export interface QuestionGenerationRequest {
  subject: string
  topic: string
  learningObjectives: string
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Mixed'
  questionCount: number
  audience: string
  instructions: string
  language: string
}

export interface GeneratedQuestion {
  id: string
  prompt: string
  options: Array<{ id: string; text: string }>
  correctOptionId: string
  explanation: string
  difficulty: QuestionDifficulty
  topic: string
  order: number
}

export interface QuestionGenerationResult {
  provider: string
  model: string
  questions: GeneratedQuestion[]
}

export interface QuestionGenerationProvider {
  readonly provider: string
  readonly model: string
  generate(request: QuestionGenerationRequest): Promise<GeneratedQuestion[]>
}

const maximumQuestions = 20
const maximumResponseBytes = 512 * 1024
const optionIds = ['A', 'B', 'C', 'D']

export class QuestionGenerationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 502 | 503 = 400
  ) {
    super(message)
    this.name = 'QuestionGenerationError'
  }
}

export function validateQuestionGenerationRequest(value: unknown): QuestionGenerationRequest {
  if (!isRecord(value)) {
    throw new QuestionGenerationError('Generation settings must be an object.')
  }
  const stringFields = [
    ['subject', 120, true],
    ['topic', 200, true],
    ['learningObjectives', 1_000, false],
    ['audience', 120, true],
    ['instructions', 1_000, false],
    ['language', 80, true]
  ] as const
  for (const [field, maximum, required] of stringFields) {
    const item = value[field]
    if (typeof item !== 'string' || item.length > maximum || (required && !item.trim())) {
      throw new QuestionGenerationError(`${fieldLabel(field)} is invalid.`)
    }
  }
  if (
    value.difficulty !== 'Easy' &&
    value.difficulty !== 'Medium' &&
    value.difficulty !== 'Hard' &&
    value.difficulty !== 'Mixed'
  ) {
    throw new QuestionGenerationError('Difficulty must be Easy, Medium, Hard, or Mixed.')
  }
  if (
    !Number.isInteger(value.questionCount) ||
    Number(value.questionCount) < 1 ||
    Number(value.questionCount) > maximumQuestions
  ) {
    throw new QuestionGenerationError(`Question count must be between 1 and ${maximumQuestions}.`)
  }
  if (value.questionType !== 'MCQ') {
    throw new QuestionGenerationError('Only MCQ questions are supported.')
  }
  if (value.optionCount !== 4) {
    throw new QuestionGenerationError(
      'The configured assessment provider requires exactly four answer options.'
    )
  }
  return {
    subject: (value.subject as string).trim(),
    topic: (value.topic as string).trim(),
    learningObjectives: (value.learningObjectives as string).trim(),
    difficulty: value.difficulty,
    questionCount: Number(value.questionCount),
    audience: (value.audience as string).trim(),
    instructions: (value.instructions as string).trim(),
    language: (value.language as string).trim()
  }
}

export function parseGeneratedQuestions(
  value: unknown,
  request: QuestionGenerationRequest
): GeneratedQuestion[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    throw new QuestionGenerationError('The AI response did not contain a questions array.', 502)
  }
  if (value.questions.length !== request.questionCount) {
    throw new QuestionGenerationError(
      `The AI returned ${value.questions.length} questions; ${request.questionCount} were requested.`,
      502
    )
  }
  const ids = new Set<string>()
  const prompts = new Set<string>()
  return value.questions.map((question, index) => {
    if (
      !isRecord(question) ||
      !hasOnlyKeys(question, [
        'id',
        'prompt',
        'options',
        'correctOptionId',
        'explanation',
        'difficulty',
        'topic',
        'order'
      ])
    ) {
      throw new QuestionGenerationError(`Question ${index + 1} has an invalid shape.`, 502)
    }
    const id = boundedText(question.id, 80)
    const prompt = boundedText(question.prompt, 2_000)
    const explanation = boundedText(question.explanation, 2_000)
    const topic = boundedText(question.topic, 300)
    if (
      !id ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) ||
      !prompt ||
      !explanation ||
      !topic ||
      !Array.isArray(question.options)
    ) {
      throw new QuestionGenerationError(`Question ${index + 1} is incomplete.`, 502)
    }
    if (ids.has(id)) {
      throw new QuestionGenerationError('The AI returned duplicate question identifiers.', 502)
    }
    ids.add(id)
    const promptKey = prompt.toLowerCase().replace(/\s+/g, ' ')
    if (prompts.has(promptKey)) {
      throw new QuestionGenerationError('The AI returned duplicate question text.', 502)
    }
    prompts.add(promptKey)
    if (question.options.length !== optionIds.length) {
      throw new QuestionGenerationError(
        `Question ${index + 1} must have exactly four answer options.`,
        502
      )
    }
    const optionIdsSeen = new Set<string>()
    const options = question.options.map((option, optionIndex) => {
      if (
        !isRecord(option) ||
        !hasOnlyKeys(option, ['id', 'text']) ||
        typeof option.id !== 'string' ||
        option.id !== optionIds[optionIndex] ||
        typeof option.text !== 'string' ||
        !option.text.trim() ||
        option.text.length > 500
      ) {
        throw new QuestionGenerationError(
          `Question ${index + 1} has an invalid answer option.`,
          502
        )
      }
      if (optionIdsSeen.has(option.id)) {
        throw new QuestionGenerationError(
          `Question ${index + 1} has duplicate option identifiers.`,
          502
        )
      }
      optionIdsSeen.add(option.id)
      return { id: option.id, text: option.text.trim() }
    })
    if (!optionIdsSeen.has(String(question.correctOptionId))) {
      throw new QuestionGenerationError(
        `Question ${index + 1} has an invalid correct answer reference.`,
        502
      )
    }
    if (
      question.difficulty !== 'Easy' &&
      question.difficulty !== 'Medium' &&
      question.difficulty !== 'Hard'
    ) {
      throw new QuestionGenerationError(`Question ${index + 1} has an invalid difficulty.`, 502)
    }
    if (request.difficulty !== 'Mixed' && question.difficulty !== request.difficulty) {
      throw new QuestionGenerationError(
        `Question ${index + 1} does not match the requested difficulty.`,
        502
      )
    }
    if (question.order !== index + 1) {
      throw new QuestionGenerationError('The AI response has invalid question ordering.', 502)
    }
    return {
      id,
      prompt,
      options,
      correctOptionId: question.correctOptionId as string,
      explanation,
      difficulty: question.difficulty,
      topic,
      order: index + 1
    }
  })
}

export class OpenAIQuestionGenerationProvider implements QuestionGenerationProvider {
  readonly provider = 'OpenAI'

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs = 45_000
  ) {}

  async generate(request: QuestionGenerationRequest): Promise<GeneratedQuestion[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          instructions:
            'Create original educational multiple-choice questions from the user settings. Be accurate and age-appropriate. Return only the requested structured JSON. Use four options with IDs A, B, C, D. Set question IDs to unique short slugs. Set order sequentially starting at 1. Include one unambiguous correct answer and a concise explanation. Never include answer keys in the question text.',
          input: JSON.stringify(request),
          max_output_tokens: Math.min(1_000 + request.questionCount * 650, 14_000),
          text: {
            format: {
              type: 'json_schema',
              name: 'pearl_mcq_question_set',
              strict: true,
              schema: questionSetSchema(request.difficulty)
            }
          }
        }),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new QuestionGenerationError(
          `The configured OpenAI provider returned HTTP ${response.status}.`,
          503
        )
      }
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > maximumResponseBytes) {
        throw new QuestionGenerationError('The AI response exceeded the size limit.', 502)
      }
      const payload = JSON.parse(body) as unknown
      const output = extractOutputText(payload)
      if (!output || Buffer.byteLength(output, 'utf8') > maximumResponseBytes) {
        throw new QuestionGenerationError(
          'The AI provider returned an empty or oversized result.',
          502
        )
      }
      return parseGeneratedQuestions(JSON.parse(output) as unknown, request)
    } catch (error) {
      if (error instanceof QuestionGenerationError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QuestionGenerationError('AI question generation timed out. Try again.', 503)
      }
      if (error instanceof TypeError) {
        throw new QuestionGenerationError(
          'Could not reach the configured AI provider. Check the backend network and provider availability.',
          503
        )
      }
      throw new QuestionGenerationError(
        'The AI provider response could not be parsed or validated. Try again.',
        502
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

export class GeminiQuestionGenerationProvider implements QuestionGenerationProvider {
  readonly provider = 'Google Gemini'
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs = 45_000
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: timeoutMs }
    })
  }

  async generate(request: QuestionGenerationRequest): Promise<GeneratedQuestion[]> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: JSON.stringify(request),
        config: {
          systemInstruction:
            'Create original educational multiple-choice questions from the user settings. Be accurate and age-appropriate. Return only the requested structured JSON. Use four options with IDs A, B, C, D. Set question IDs to unique short slugs. Set order sequentially starting at 1. Include one unambiguous correct answer and a concise explanation. Never include answer keys in the question text.',
          responseMimeType: 'application/json',
          responseJsonSchema: questionSetSchema(request.difficulty),
          maxOutputTokens: Math.min(1_000 + request.questionCount * 650, 14_000),
          temperature: 0.3
        }
      })
      const output = response.text
      if (!output || Buffer.byteLength(output, 'utf8') > maximumResponseBytes) {
        throw new QuestionGenerationError('Gemini returned an empty or oversized result.', 502)
      }
      return parseGeneratedQuestions(JSON.parse(output) as unknown, request)
    } catch (error) {
      if (error instanceof QuestionGenerationError) throw error
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
          throw new QuestionGenerationError(
            'Gemini authentication or API permission failed. Check the backend API key and access.',
            503
          )
        }
        if (error.status === 404) {
          throw new QuestionGenerationError(
            `Gemini model "${this.model}" is unavailable to this API key.`,
            503
          )
        }
        if (error.status === 429) {
          throw new QuestionGenerationError(
            'Gemini quota or rate limit was reached. Try again later.',
            503
          )
        }
        throw new QuestionGenerationError(
          `Gemini question generation failed (HTTP ${error.status}).`,
          503
        )
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QuestionGenerationError('Gemini question generation timed out. Try again.', 503)
      }
      if (error instanceof TypeError) {
        throw new QuestionGenerationError(
          'Could not reach Gemini. Check the backend network connection.',
          503
        )
      }
      throw new QuestionGenerationError(
        'The Gemini response could not be parsed or validated. Try again.',
        502
      )
    }
  }
}

function questionSetSchema(
  difficulty: QuestionGenerationRequest['difficulty']
): Record<string, unknown> {
  const difficultyValues = difficulty === 'Mixed' ? ['Easy', 'Medium', 'Hard'] : [difficulty]
  return {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'prompt',
            'options',
            'correctOptionId',
            'explanation',
            'difficulty',
            'topic',
            'order'
          ],
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text'],
                properties: {
                  id: { type: 'string', enum: optionIds },
                  text: { type: 'string' }
                }
              }
            },
            correctOptionId: { type: 'string', enum: optionIds },
            explanation: { type: 'string' },
            difficulty: { type: 'string', enum: difficultyValues },
            topic: { type: 'string' },
            order: { type: 'integer' }
          }
        }
      }
    }
  }
}

function extractOutputText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.output_text === 'string') return value.output_text
  if (!Array.isArray(value.output)) return undefined
  for (const item of value.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        return content.text
      }
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value)
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maximum
    ? value.trim()
    : undefined
}

function fieldLabel(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
}
