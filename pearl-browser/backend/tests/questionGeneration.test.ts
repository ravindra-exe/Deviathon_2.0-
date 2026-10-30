import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAIQuestionGenerationProvider,
  parseGeneratedQuestions,
  QuestionGenerationError,
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

const questionSet = {
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
      explanation: 'The nucleus contains most of a eukaryotic cell genetic material.',
      difficulty: 'Medium',
      topic: 'Cell structure',
      order: 1
    }
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('question generation validation', () => {
  it('accepts a complete structured question set', () => {
    expect(parseGeneratedQuestions(questionSet, request)).toEqual(questionSet.questions)
  })

  it('rejects invalid counts, duplicated question text, and missing answer references', () => {
    expect(() =>
      validateQuestionGenerationRequest({
        ...request,
        questionCount: 21
      })
    ).toThrow(QuestionGenerationError)
    expect(() =>
      parseGeneratedQuestions(
        {
          questions: [
            ...questionSet.questions,
            { ...questionSet.questions[0], id: 'another-id', order: 2 }
          ]
        },
        { ...request, questionCount: 2 }
      )
    ).toThrow('duplicate question text')
    expect(() =>
      parseGeneratedQuestions(
        {
          questions: [{ ...questionSet.questions[0], correctOptionId: 'missing' }]
        },
        request
      )
    ).toThrow('invalid correct answer reference')
  })

  it('uses the real OpenAI Responses API contract and validates returned JSON (mocked network)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify(questionSet)
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAIQuestionGenerationProvider('test-api-key', 'test-model')

    await expect(provider.generate(request)).resolves.toEqual(questionSet.questions)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'test-model',
      store: false,
      text: { format: { type: 'json_schema', strict: true } }
    })
  })

  it('rejects malformed or oversized provider output without returning a success-shaped response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ output_text: '{"questions":[' }), { status: 200 })
        )
    )
    const provider = new OpenAIQuestionGenerationProvider('test-api-key', 'test-model')
    await expect(provider.generate(request)).rejects.toMatchObject({
      name: 'QuestionGenerationError',
      statusCode: 502
    })
  })
})
