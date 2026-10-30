import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateContent } = vi.hoisted(() => ({
  generateContent: vi.fn()
}))

vi.mock('@google/genai', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
    }
  },
  GoogleGenAI: class GoogleGenAI {
    models = { generateContent }
  }
}))

import { GeminiProctoringInsightProvider } from '../src/proctoringInsights'
import type { AssessmentAuditEvent } from '../src/audit'

const event: AssessmentAuditEvent = {
  id: 'event-1',
  assessmentId: 'private-assessment',
  attemptId: 'private-attempt',
  type: 'face_not_detected',
  occurredAt: '2026-03-01T12:00:00.000Z',
  hostname: 'private.example',
  url: 'https://private.example/path?token=do-not-send',
  query: 'private search text',
  observationDurationMs: 5_200,
  observationCount: 6,
  confidence: 0.87
}

const modelResponse = {
  summary: 'A sustained face absence signal was recorded.',
  supportingEventIds: ['event-1'],
  riskIndicators: [{ text: 'Sustained face absence signal.', evidenceEventIds: ['event-1'] }],
  confidenceLimitations: ['A camera signal alone does not establish intent.'],
  reviewerRecommendations: ['Review the recorded event in context.']
}

describe('Gemini proctoring insight provider', () => {
  beforeEach(() => {
    generateContent.mockReset()
    generateContent.mockResolvedValue({ text: JSON.stringify(modelResponse) })
  })

  it('sends allowlisted metadata and derives displayed facts from recorded events', async () => {
    const provider = new GeminiProctoringInsightProvider('test-api-key', 'gemini-test-model')

    const result = await provider.summarize([event])

    expect(result).toMatchObject({
      status: 'available',
      provider: 'Google Gemini',
      model: 'gemini-test-model',
      summary: modelResponse.summary,
      observedFacts: [
        {
          eventId: event.id,
          type: event.type,
          occurredAt: event.occurredAt,
          observationDurationMs: event.observationDurationMs,
          observationCount: event.observationCount,
          confidence: event.confidence
        }
      ],
      supportingEventIds: ['event-1'],
      riskIndicators: modelResponse.riskIndicators
    })
    const request = generateContent.mock.calls[0][0]
    expect(request.model).toBe('gemini-test-model')
    expect(request.config.responseMimeType).toBe('application/json')
    expect(request.config.responseJsonSchema).toBeDefined()
    expect(request.contents).not.toContain('private-assessment')
    expect(request.contents).not.toContain('private-attempt')
    expect(request.contents).not.toContain('private.example')
    expect(request.contents).not.toContain('private search text')
    expect(request.contents).not.toContain('token=do-not-send')
  })

  it('rejects unknown event citations rather than accepting model-invented evidence', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        ...modelResponse,
        supportingEventIds: ['invented-event']
      })
    })
    const provider = new GeminiProctoringInsightProvider('test-api-key', 'gemini-test-model')

    await expect(provider.summarize([event])).rejects.toThrow(
      'Gemini cited an unknown or missing event identifier.'
    )
  })

  it('sanitizes API failures before returning them to the application', async () => {
    generateContent.mockRejectedValue(
      new Error('raw response body with sensitive provider details')
    )
    const provider = new GeminiProctoringInsightProvider('test-api-key', 'gemini-test-model')

    await expect(provider.summarize([event])).rejects.toThrow(
      'Gemini response could not be parsed or validated.'
    )
  })
})
