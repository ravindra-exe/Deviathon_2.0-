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

import {
  GeminiQuestionGenerationProvider,
  validateQuestionGenerationRequest
} from '../src/questionGeneration'

const request = validateQuestionGenerationRequest({
  subject: 'Biology',
  topic: 'Cell structure',
  learningObjectives: 'Compare plant and animal cells.',
  difficulty: 'Medium',
  questionCount: 1,
  optionCount: 4,
  questionType: 'MCQ',
  audience: 'Grade 10',
  instructions: '',
  language: 'English'
})

const generated = {
  questions: [
    {
      id: 'cell-parts',
      prompt: 'Which structure contains genetic material?',
      options: [
        { id: 'A', text: 'Nucleus' },
        { id: 'B', text: 'Cell wall' },
        { id: 'C', text: 'Ribosome' },
        { id: 'D', text: 'Vacuole' }
      ],
      correctOptionId: 'A',
      explanation: 'The nucleus contains most genetic material in a eukaryotic cell.',
      difficulty: 'Medium',
      topic: 'Cell structure',
      order: 1
    }
  ]
}

describe('Gemini question generation provider', () => {
  beforeEach(() => {
    generateContent.mockReset()
    generateContent.mockResolvedValue({ text: JSON.stringify(generated) })
  })

  it('uses the Gemini structured-output API and validates the returned question set', async () => {
    const provider = new GeminiQuestionGenerationProvider('test-api-key', 'gemini-test-model')

    await expect(provider.generate(request)).resolves.toEqual(generated.questions)
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-test-model',
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseJsonSchema: expect.any(Object)
        })
      })
    )
  })

  it('rejects malformed model output', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ questions: [] }) })
    const provider = new GeminiQuestionGenerationProvider('test-api-key', 'gemini-test-model')

    await expect(provider.generate(request)).rejects.toThrow('AI returned 0 questions')
  })
})
