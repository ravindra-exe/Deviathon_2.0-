import type {
  ProctoringInsightObservation,
  ProctoringInsightResult
} from '../../src/shared/assessment'
import type { AssessmentAuditEvent } from './audit'

export interface ProctoringInsightProvider {
  summarize(events: readonly AssessmentAuditEvent[]): Promise<ProctoringInsightObservation[]>
}

export class OpenAIProctoringInsightProvider implements ProctoringInsightProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 12_000
  ) {}

  async summarize(
    events: readonly AssessmentAuditEvent[]
  ): Promise<ProctoringInsightObservation[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const eventIds = new Set(events.map((event) => event.id))
    const evidence = events.slice(-100).map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(event.hostname ? { hostname: event.hostname } : {}),
      ...(event.fromHostname ? { fromHostname: event.fromHostname } : {}),
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
      return parseObservations(parsed, eventIds)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('The AI summary request timed out.')
      }
      if (error instanceof Error && error.message.startsWith('The configured AI provider')) {
        throw error
      }
      throw new Error(
        'The AI summary could not be validated. Deterministic review rules remain available.'
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createProctoringInsightResult(
  observations: ProctoringInsightObservation[]
): ProctoringInsightResult {
  return {
    status: 'available',
    message: 'Generated from structured backend-recorded event metadata.',
    observations
  }
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
