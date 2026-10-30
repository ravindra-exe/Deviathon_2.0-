import { ApiError, GoogleGenAI } from '@google/genai'
import type {
  ProctoringInsightObservation,
  ProctoringInsightResult
} from '../../src/shared/assessment'
import type { AssessmentAuditEvent } from './audit'

export interface ProctoringInsightProvider {
  readonly provider: string
  readonly model: string
  summarize(events: readonly AssessmentAuditEvent[]): Promise<ProctoringInsightResult>
}

class GeminiInsightError extends Error {}

export class OpenAIProctoringInsightProvider implements ProctoringInsightProvider {
  readonly provider = 'OpenAI'

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs = 12_000
  ) {}

  async summarize(events: readonly AssessmentAuditEvent[]): Promise<ProctoringInsightResult> {
    const selectedEvents = events.slice(-100)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const eventIds = new Set(selectedEvents.map((event) => event.id))
    const evidence = selectedEvents.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.observationCount !== undefined ? { observationCount: event.observationCount } : {}),
      ...(event.observationDurationMs !== undefined
        ? { observationDurationMs: event.observationDurationMs }
        : {}),
      ...(event.confidence !== undefined ? { confidence: event.confidence } : {})
    }))
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
            'Review only the supplied structured Pearl Browser assessment event metadata. Distinguish recorded observations from inferences. Never call a participant guilty or claim an event proves cheating. Mention uncertainty and plausible camera, lighting, device, or ordinary-behavior explanations. Cite only supplied event IDs. Do not infer anything about unseen desktop activity.',
          input: JSON.stringify(evidence),
          max_output_tokens: 600,
          text: {
            format: {
              type: 'json_schema',
              name: 'proctoring_observations',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['observations'],
                properties: {
                  observations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['kind', 'text', 'evidenceEventIds', 'uncertainty'],
                      properties: {
                        kind: { type: 'string', enum: ['observed', 'inference'] },
                        text: { type: 'string' },
                        evidenceEventIds: {
                          type: 'array',
                          items: { type: 'string' }
                        },
                        uncertainty: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`The configured AI provider returned HTTP ${response.status}.`)
      }
      const payload = (await response.json()) as unknown
      const text = extractOutputText(payload)
      if (!text) throw new Error('The configured AI provider returned no summary.')
      const parsed = JSON.parse(text) as unknown
      const observations = parseObservations(parsed, eventIds)
      return createProctoringInsightResult(selectedEvents, observations, this.provider, this.model)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('The AI summary request timed out.', { cause: error })
      }
      if (error instanceof Error && error.message.startsWith('The configured AI provider')) {
        throw error
      }
      throw new Error(
        'The AI summary could not be validated. Deterministic review rules remain available.',
        { cause: error }
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createProctoringInsightResult(
  events: readonly AssessmentAuditEvent[],
  observations: ProctoringInsightObservation[],
  provider: string,
  model: string
): ProctoringInsightResult {
  const supportingEventIds = [
    ...new Set(observations.flatMap((observation) => observation.evidenceEventIds))
  ]
  const eventsById = new Map(events.map((event) => [event.id, event]))
  const observedFacts = supportingEventIds.flatMap((id) => {
    const event = eventsById.get(id)
    return event ? [toObservedFact(event)] : []
  })
  return {
    status: 'available',
    message: 'Generated from structured backend-recorded event metadata.',
    provider,
    model,
    summary: observations
      .map((observation) => observation.text)
      .join(' ')
      .slice(0, 1_500),
    observedFacts,
    supportingEventIds,
    riskIndicators: observations
      .filter((observation) => observation.kind === 'inference')
      .map((observation) => ({
        text: observation.text,
        evidenceEventIds: observation.evidenceEventIds
      })),
    confidenceLimitations: [
      ...new Set(observations.map((observation) => observation.uncertainty).filter(Boolean))
    ].slice(0, 8),
    reviewerRecommendations: [],
    observations
  }
}

const insightSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    supportingEventIds: { type: 'array', items: { type: 'string' } },
    riskIndicators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          evidenceEventIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['text', 'evidenceEventIds'],
        additionalProperties: false
      }
    },
    confidenceLimitations: { type: 'array', items: { type: 'string' } },
    reviewerRecommendations: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'summary',
    'supportingEventIds',
    'riskIndicators',
    'confidenceLimitations',
    'reviewerRecommendations'
  ],
  additionalProperties: false
}

const maximumInsightResponseBytes = 64 * 1024

export class GeminiProctoringInsightProvider implements ProctoringInsightProvider {
  readonly provider = 'Google Gemini'
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs = 60_000
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: timeoutMs }
    })
  }

  async summarize(events: readonly AssessmentAuditEvent[]): Promise<ProctoringInsightResult> {
    const selectedEvents = events.slice(-100)
    if (selectedEvents.length === 0) {
      throw new GeminiInsightError('No recorded proctoring events are available to summarize.')
    }

    const evidence = selectedEvents.map(toGeminiEvidence)
    const eventIds = new Set(selectedEvents.map((event) => event.id))
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: JSON.stringify({ events: evidence }),
        config: {
          systemInstruction:
            'You are summarizing structured proctoring event metadata for a human reviewer. Use only facts supported by the supplied events. Do not invent, alter, or infer event types, timestamps, durations, counts, confidence values, or identifiers. Do not decide misconduct or guilt. Do not recommend automatic disqualification. Use only supplied event IDs in supportingEventIds and risk indicator citations. Explain that metadata alone cannot establish intent and mention reasonable technical or behavioral uncertainty. Recommendations must be for human review only.',
          responseMimeType: 'application/json',
          responseJsonSchema: insightSchema,
          maxOutputTokens: 700,
          temperature: 0.1
        }
      })
      const text = response.text
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        Buffer.byteLength(text, 'utf8') > maximumInsightResponseBytes
      ) {
        throw new GeminiInsightError('Gemini returned an empty or oversized structured response.')
      }
      const parsed = JSON.parse(text) as unknown
      return parseGeminiInsight(parsed, selectedEvents, eventIds, this.model)
    } catch (error) {
      throw sanitizeGeminiError(error, this.model)
    }
  }
}

function toGeminiEvidence(event: AssessmentAuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(event.observationCount !== undefined ? { observationCount: event.observationCount } : {}),
    ...(event.observationDurationMs !== undefined
      ? { observationDurationMs: event.observationDurationMs }
      : {}),
    ...(event.confidence !== undefined ? { confidence: event.confidence } : {})
  }
}

function toObservedFact(event: AssessmentAuditEvent): {
  eventId: string
  type: string
  occurredAt: string
  observationCount?: number
  observationDurationMs?: number
  confidence?: number
} {
  return {
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(event.observationCount !== undefined ? { observationCount: event.observationCount } : {}),
    ...(event.observationDurationMs !== undefined
      ? { observationDurationMs: event.observationDurationMs }
      : {}),
    ...(event.confidence !== undefined ? { confidence: event.confidence } : {})
  }
}

function parseGeminiInsight(
  value: unknown,
  events: readonly AssessmentAuditEvent[],
  eventIds: ReadonlySet<string>,
  model: string
): ProctoringInsightResult {
  if (!isRecord(value) || !hasOnlyKeys(value, Object.keys(insightSchema.properties))) {
    throw new GeminiInsightError('Gemini returned an unsupported structured response.')
  }
  const summary = boundedString(value.summary, 1_500)
  const supportingEventIds = validateEventIds(value.supportingEventIds, eventIds, true)
  if (!summary || supportingEventIds.length === 0) {
    throw new GeminiInsightError(
      'Gemini returned an incomplete summary or omitted its event citations.'
    )
  }
  if (
    !Array.isArray(value.riskIndicators) ||
    value.riskIndicators.length > 8 ||
    !Array.isArray(value.confidenceLimitations) ||
    value.confidenceLimitations.length > 8 ||
    !Array.isArray(value.reviewerRecommendations) ||
    value.reviewerRecommendations.length > 8
  ) {
    throw new GeminiInsightError('Gemini returned invalid insight sections.')
  }
  const riskIndicators = value.riskIndicators.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['text', 'evidenceEventIds'])) {
      throw new GeminiInsightError('Gemini returned an invalid risk indicator.')
    }
    const text = boundedString(item.text, 500)
    const citedEventIds = validateEventIds(item.evidenceEventIds, eventIds, true)
    if (!text || citedEventIds.some((id) => !supportingEventIds.includes(id))) {
      throw new GeminiInsightError('Gemini returned an unsupported risk indicator citation.')
    }
    return { text, evidenceEventIds: citedEventIds }
  })
  const confidenceLimitations = parseStringList(value.confidenceLimitations, 500)
  const reviewerRecommendations = parseStringList(value.reviewerRecommendations, 500)
  const eventsById = new Map(events.map((event) => [event.id, event]))
  const observedFacts = supportingEventIds.flatMap((id) => {
    const event = eventsById.get(id)
    return event ? [toObservedFact(event)] : []
  })
  if (observedFacts.length !== supportingEventIds.length) {
    throw new GeminiInsightError('Gemini cited an event that is not in the supplied evidence.')
  }
  return {
    status: 'available',
    message: 'Gemini explanation of structured, backend-recorded event metadata.',
    provider: 'Google Gemini',
    model,
    summary,
    observedFacts,
    supportingEventIds,
    riskIndicators,
    confidenceLimitations,
    reviewerRecommendations
  }
}

function validateEventIds(
  value: unknown,
  validIds: ReadonlySet<string>,
  requireAtLeastOne: boolean
): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new GeminiInsightError('Gemini returned an invalid event citation list.')
  }
  const ids = value as unknown[]
  const uniqueIds = [...new Set(ids)]
  const stringIds = uniqueIds.filter((id): id is string => typeof id === 'string')
  if (
    uniqueIds.length !== ids.length ||
    stringIds.some((id) => !validIds.has(id)) ||
    (requireAtLeastOne && stringIds.length === 0)
  ) {
    throw new GeminiInsightError('Gemini cited an unknown or missing event identifier.')
  }
  return stringIds
}

function parseStringList(value: unknown, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new GeminiInsightError('Gemini returned an invalid text list.')
  }
  return value.map((item) => {
    const text = boundedString(item, maximumLength)
    if (!text) throw new GeminiInsightError('Gemini returned an empty text entry.')
    return text
  })
}

function boundedString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text && text.length <= maximumLength ? text : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function sanitizeGeminiError(error: unknown, model: string): Error {
  if (error instanceof GeminiInsightError) return error
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return new Error(
        'Gemini authentication or API permission failed. Check the backend API key and access.'
      )
    }
    if (error.status === 404) {
      return new Error(`Gemini model "${model}" is unavailable to this API key.`)
    }
    if (error.status === 429) {
      return new Error('Gemini quota or rate limit was reached. Try again later.')
    }
    if (error.status >= 500) {
      return new Error(`Gemini service returned HTTP ${error.status}. Try again later.`)
    }
    return new Error(
      `Gemini rejected the request (HTTP ${error.status}). Check the model and request configuration.`
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('Gemini summary request timed out. Try again.')
  }
  if (error instanceof TypeError) {
    return new Error('Could not reach Gemini. Check the backend network connection.')
  }
  return new Error('Gemini response could not be parsed or validated.')
}

function extractOutputText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const payload = value as { output_text?: unknown; output?: unknown }
  if (typeof payload.output_text === 'string') return payload.output_text
  if (!Array.isArray(payload.output)) return undefined
  for (const item of payload.output) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Array.isArray((item as { content?: unknown }).content)
    ) {
      continue
    }
    for (const content of (item as { content: unknown[] }).content) {
      if (
        content &&
        typeof content === 'object' &&
        (content as { type?: unknown }).type === 'output_text' &&
        typeof (content as { text?: unknown }).text === 'string'
      ) {
        return (content as { text: string }).text
      }
    }
  }
  return undefined
}

function parseObservations(
  value: unknown,
  eventIds: ReadonlySet<string>
): ProctoringInsightObservation[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { observations?: unknown }).observations)
  ) {
    throw new Error('AI summary response has an invalid shape.')
  }
  return (value as { observations: unknown[] }).observations
    .slice(0, 8)
    .flatMap((item): ProctoringInsightObservation[] => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      if (
        (entry.kind !== 'observed' && entry.kind !== 'inference') ||
        typeof entry.text !== 'string' ||
        typeof entry.uncertainty !== 'string' ||
        !Array.isArray(entry.evidenceEventIds)
      ) {
        return []
      }
      const cited = entry.evidenceEventIds.filter(
        (id): id is string => typeof id === 'string' && eventIds.has(id)
      )
      if (!entry.text.trim() || cited.length === 0) return []
      return [
        {
          kind: entry.kind,
          text: entry.text.trim().slice(0, 500),
          evidenceEventIds: [...new Set(cited)].slice(0, 10),
          uncertainty: entry.uncertainty.trim().slice(0, 300)
        }
      ]
    })
}
