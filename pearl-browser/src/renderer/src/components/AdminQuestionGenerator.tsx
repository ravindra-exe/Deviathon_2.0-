import { useMemo, useState } from 'react'
import type {
  AdminAssessmentDraft,
  AdminQuestionDraft,
  AdminQuestionGenerationRequest,
  AdminConsoleAssessment
} from '../../../shared/admin'

const initialGenerationSettings: AdminQuestionGenerationRequest = {
  subject: '',
  topic: '',
  learningObjectives: '',
  difficulty: 'Mixed',
  questionCount: 5,
  optionCount: 4,
  questionType: 'MCQ',
  audience: '',
  instructions: '',
  language: 'English'
}

function createQuestionId(): string {
  return `q-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

function createAssessmentId(): string {
  return `paper-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function validateDraft(draft: AdminAssessmentDraft): string {
  if (!draft.title.trim()) return 'Enter an assessment title.'
  if (!draft.instructions.trim()) return 'Enter student instructions for the assessment.'
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(draft.id)) {
    return 'Assessment ID must begin with a letter or number and contain only letters, numbers, hyphens, or underscores.'
  }
  if (
    !Number.isInteger(draft.durationMinutes) ||
    draft.durationMinutes < 1 ||
    draft.durationMinutes > 1_440
  ) {
    return 'Duration must be between 1 and 1,440 minutes.'
  }
  if (draft.questions.length < 1 || draft.questions.length > 20) {
    return 'Add between 1 and 20 active questions before saving.'
  }
  if (new Set(draft.questions.map((question) => question.id)).size !== draft.questions.length) {
    return 'Question IDs must be unique.'
  }
  for (const [index, question] of draft.questions.entries()) {
    if (!question.prompt.trim()) return `Question ${index + 1} needs question text.`
    if (!question.explanation.trim()) return `Question ${index + 1} needs an explanation.`
    if (
      question.options.length !== 4 ||
      question.options.some((option) => !option.text.trim()) ||
      new Set(question.options.map((option) => option.id)).size !== 4
    ) {
      return `Question ${index + 1} needs four non-empty, uniquely identified options.`
    }
    if (!question.options.some((option) => option.id === question.correctOptionId)) {
      return `Question ${index + 1} needs a correct answer selected.`
    }
  }
  return ''
}

function makeBlankQuestion(order: number, topic: string): AdminQuestionDraft {
  return {
    id: createQuestionId(),
    prompt: '',
    options: ['A', 'B', 'C', 'D'].map((id) => ({ id, text: '' })),
    correctOptionId: 'A',
    explanation: '',
    difficulty: 'Medium',
    topic: topic.trim() || 'Learning objective',
    order
  }
}

export function AdminQuestionGenerator({
  assessments,
  onSaved
}: {
  assessments: AdminConsoleAssessment[]
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [settings, setSettings] = useState(initialGenerationSettings)
  const [title, setTitle] = useState('')
  const [assessmentId, setAssessmentId] = useState(createAssessmentId)
  const [assessmentInstructions, setAssessmentInstructions] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(30)
  const [questions, setQuestions] = useState<AdminQuestionDraft[]>([])
  const [providerInfo, setProviderInfo] = useState('')
  const [generationState, setGenerationState] = useState<'idle' | 'generating'>('idle')
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saved, setSaved] = useState(false)
  const [published, setPublished] = useState(false)
  const [preview, setPreview] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const draft = useMemo<AdminAssessmentDraft>(
    () => ({
      id: assessmentId,
      title,
      instructions: assessmentInstructions,
      durationMinutes,
      questions: questions.map((question, index) => ({ ...question, order: index + 1 }))
    }),
    [assessmentId, title, assessmentInstructions, durationMinutes, questions]
  )
  const draftError = validateDraft(draft)

  function updateQuestion(
    questionId: string,
    update: (question: AdminQuestionDraft) => AdminQuestionDraft
  ): void {
    setQuestions((current) =>
      current.map((question) => (question.id === questionId ? update(question) : question))
    )
  }

  function reorderQuestion(index: number, offset: -1 | 1): void {
    setQuestions((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next.map((question, order) => ({ ...question, order: order + 1 }))
    })
  }

  async function generateQuestions(replaceAll = false): Promise<void> {
    setError('')
    setNotice('')
    setGenerationState('generating')
    try {
      const result = await window.browser.admin.generateQuestions(settings)
      const incoming = result.questions.map((question) => ({
        ...question,
        id: createQuestionId(),
        order: 0
      }))
      const merged = replaceAll ? incoming : [...questions, ...incoming]
      if (merged.length > 20) {
        throw new Error('The active question limit is 20. Remove questions before generating more.')
      }
      setQuestions(merged.map((question, index) => ({ ...question, order: index + 1 })))
      setProviderInfo(`${result.provider} · ${result.model}`)
      setNotice(
        `${result.questions.length} questions generated. Review and edit every question before saving.`
      )
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Question generation failed.')
    } finally {
      setGenerationState('idle')
    }
  }

  async function regenerateQuestion(questionId: string): Promise<void> {
    const current = questions.find((question) => question.id === questionId)
    if (!current) return
    setError('')
    setNotice('')
    setGenerationState('generating')
    try {
      const result = await window.browser.admin.generateQuestions({
        ...settings,
        topic: current.topic || settings.topic,
        difficulty: current.difficulty,
        questionCount: 1,
        instructions: [
          settings.instructions,
          `Regenerate this question as a distinct replacement: ${current.prompt}`
        ]
          .filter(Boolean)
          .join('\n')
      })
      const replacement = { ...result.questions[0], id: current.id, order: current.order }
      updateQuestion(questionId, () => replacement)
      setProviderInfo(`${result.provider} · ${result.model}`)
      setNotice('The selected question was regenerated. Review it before saving.')
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Question regeneration failed.'
      )
    } finally {
      setGenerationState('idle')
    }
  }

  async function saveDraft(): Promise<void> {
    setError('')
    setNotice('')
    const validation = validateDraft(draft)
    if (validation) {
      setError(validation)
      return
    }
    if (assessments.some((assessment) => assessment.id === draft.id)) {
      setError('This assessment ID already exists. Choose a new ID.')
      return
    }
    setSaving(true)
    try {
      const result = await window.browser.admin.saveAssessmentDraft(draft)
      setSaved(true)
      setNotice(
        `Draft saved to the configured assessment provider as ${result.assessmentId} (${result.questionCount} questions). It is not published.`
      )
      await onSaved()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Draft save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function publishDraft(): Promise<void> {
    setError('')
    setPublishing(true)
    try {
      const result = await window.browser.admin.publishAssessment(draft.id)
      setPublished(result.published)
      setConfirmPublish(false)
      setNotice(`Assessment ${result.assessmentId} is now published.`)
      await onSaved()
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Assessment publication failed.'
      )
    } finally {
      setPublishing(false)
    }
  }

  const disabled = saved || published

  return (
    <section className="question-generator">
      <section className="admin-card">
        <div className="admin-card-heading">
          <div>
            <h2>AI Question Generator</h2>
            <p className="generator-subtitle">
              Generate a draft with the configured server-side AI provider, then review and approve
              it.
            </p>
          </div>
          <span>{questions.length} / 20 questions</span>
        </div>
        <p className="admin-notice">
          AI-generated content can be inaccurate. Review every question, answer key, and explanation
          before saving or publishing. The current Airtable contract supports exactly four options.
        </p>
        {!saved && (
          <div className="generator-settings">
            <label>
              Subject
              <input
                maxLength={120}
                value={settings.subject}
                disabled={generationState === 'generating'}
                onChange={(event) => setSettings({ ...settings, subject: event.target.value })}
              />
            </label>
            <label>
              Topic
              <input
                maxLength={200}
                value={settings.topic}
                disabled={generationState === 'generating'}
                onChange={(event) => setSettings({ ...settings, topic: event.target.value })}
              />
            </label>
            <label className="generator-field-wide">
              Subtopic or learning objectives
              <textarea
                maxLength={1_000}
                rows={2}
                value={settings.learningObjectives}
                disabled={generationState === 'generating'}
                onChange={(event) =>
                  setSettings({ ...settings, learningObjectives: event.target.value })
                }
              />
            </label>
            <label>
              Difficulty
              <select
                value={settings.difficulty}
                disabled={generationState === 'generating'}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    difficulty: event.target.value as AdminQuestionGenerationRequest['difficulty']
                  })
                }
              >
                <option>Easy</option>
                <option>Medium</option>
                <option>Hard</option>
                <option>Mixed</option>
              </select>
            </label>
            <label>
              Number of questions (1-20)
              <input
                type="number"
                min={1}
                max={20}
                value={settings.questionCount}
                disabled={generationState === 'generating'}
                onChange={(event) =>
                  setSettings({ ...settings, questionCount: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Number of answer options
              <select value="4" disabled aria-describedby="generator-option-note">
                <option value="4">4 — required by current assessment provider</option>
              </select>
              <small id="generator-option-note">
                The current Airtable Questions mapping accepts four choices.
              </small>
            </label>
            <label>
              Question type
              <select value="MCQ" disabled>
                <option value="MCQ">Multiple choice (MCQ)</option>
              </select>
            </label>
            <label>
              Target audience / educational level
              <input
                maxLength={120}
                value={settings.audience}
                disabled={generationState === 'generating'}
                onChange={(event) => setSettings({ ...settings, audience: event.target.value })}
              />
            </label>
            <label>
              Language
              <input
                maxLength={80}
                value={settings.language}
                disabled={generationState === 'generating'}
                onChange={(event) => setSettings({ ...settings, language: event.target.value })}
              />
            </label>
            <label className="generator-field-wide">
              Additional instructions (optional)
              <textarea
                maxLength={1_000}
                rows={2}
                value={settings.instructions}
                disabled={generationState === 'generating'}
                onChange={(event) => setSettings({ ...settings, instructions: event.target.value })}
              />
            </label>
          </div>
        )}
        {generationState === 'generating' && (
          <p className="generator-progress" role="status">
            <span className="generator-spinner" /> Contacting the configured AI provider and
            validating its structured response…
          </p>
        )}
        {providerInfo && <p className="generator-model">Provider: {providerInfo}</p>}
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="admin-success" role="status">
            {notice}
          </p>
        )}
        {!saved && (
          <div className="generator-actions">
            <button
              className="admin-primary-button"
              onClick={() => void generateQuestions()}
              disabled={
                generationState === 'generating' ||
                !settings.subject.trim() ||
                !settings.topic.trim() ||
                !settings.audience.trim() ||
                !settings.language.trim() ||
                questions.length + settings.questionCount > 20
              }
            >
              {generationState === 'generating' ? 'Generating…' : 'Generate questions'}
            </button>
            {questions.length > 0 && (
              <button
                className="admin-secondary-button"
                onClick={() => void generateQuestions(true)}
                disabled={
                  generationState === 'generating' ||
                  settings.questionCount < 1 ||
                  settings.questionCount > 20
                }
              >
                Regenerate all questions
              </button>
            )}
          </div>
        )}
      </section>

      <section className="admin-card">
        <div className="admin-card-heading">
          <h2>Assessment configuration</h2>
          <span>{published ? 'Published' : saved ? 'Saved draft' : 'Not saved'}</span>
        </div>
        <div className="generator-settings">
          <label>
            Assessment title
            <input
              maxLength={200}
              value={title}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Assessment ID
            <input
              maxLength={128}
              value={assessmentId}
              disabled={disabled}
              onChange={(event) => setAssessmentId(event.target.value)}
            />
          </label>
          <label>
            Duration (minutes)
            <input
              type="number"
              min={1}
              max={1_440}
              value={durationMinutes}
              disabled={disabled}
              onChange={(event) => setDurationMinutes(Number(event.target.value))}
            />
          </label>
          <label className="generator-field-wide">
            Student instructions
            <textarea
              maxLength={2_000}
              rows={2}
              value={assessmentInstructions}
              disabled={disabled}
              onChange={(event) => setAssessmentInstructions(event.target.value)}
            />
          </label>
        </div>
        <p className="admin-notice">
          The existing Airtable Questions table has no explanation field. Explanations are editable
          here for instructor review, but are not written to Airtable; no schema changes are made.
        </p>
      </section>

      <section className="admin-card">
        <div className="admin-card-heading">
          <h2>Question review</h2>
          <span>{questions.length} generated or added</span>
        </div>
        {questions.length === 0 ? (
          <p className="admin-empty">
            Set generation requirements and generate questions to begin.
          </p>
        ) : (
          <div className="generator-question-list">
            {questions.map((question, index) => (
              <article className="generator-question" key={question.id}>
                <header className="generator-question-heading">
                  <strong>Question {index + 1}</strong>
                  <span className={`generator-difficulty ${question.difficulty.toLowerCase()}`}>
                    {question.difficulty}
                  </span>
                  {!saved && (
                    <div className="generator-question-actions">
                      <button
                        className="admin-secondary-button"
                        disabled={index === 0 || generationState === 'generating'}
                        onClick={() => reorderQuestion(index, -1)}
                      >
                        Move up
                      </button>
                      <button
                        className="admin-secondary-button"
                        disabled={
                          index === questions.length - 1 || generationState === 'generating'
                        }
                        onClick={() => reorderQuestion(index, 1)}
                      >
                        Move down
                      </button>
                      <button
                        className="admin-secondary-button"
                        disabled={generationState === 'generating'}
                        onClick={() => void regenerateQuestion(question.id)}
                      >
                        Regenerate
                      </button>
                      <button
                        className="admin-secondary-button"
                        disabled={generationState === 'generating'}
                        onClick={() =>
                          setQuestions((current) =>
                            current
                              .filter((item) => item.id !== question.id)
                              .map((item, order) => ({ ...item, order: order + 1 }))
                          )
                        }
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </header>
                <label className="generator-block-field">
                  Question text
                  <textarea
                    maxLength={2_000}
                    rows={3}
                    value={question.prompt}
                    disabled={disabled}
                    onChange={(event) =>
                      updateQuestion(question.id, (item) => ({
                        ...item,
                        prompt: event.target.value
                      }))
                    }
                  />
                </label>
                <div className="generator-options">
                  {question.options.map((option, optionIndex) => (
                    <label className="generator-option" key={option.id}>
                      <span>
                        <input
                          type="radio"
                          name={`correct-${question.id}`}
                          checked={question.correctOptionId === option.id}
                          disabled={disabled}
                          onChange={() =>
                            updateQuestion(question.id, (item) => ({
                              ...item,
                              correctOptionId: option.id
                            }))
                          }
                        />
                        Correct
                      </span>
                      <textarea
                        aria-label={`Question ${index + 1} option ${option.id}`}
                        maxLength={500}
                        rows={2}
                        value={option.text}
                        disabled={disabled}
                        onChange={(event) =>
                          updateQuestion(question.id, (item) => ({
                            ...item,
                            options: item.options.map((choice) =>
                              choice.id === option.id
                                ? { ...choice, text: event.target.value }
                                : choice
                            )
                          }))
                        }
                      />
                      {!disabled && (
                        <div className="generator-option-order">
                          <button
                            type="button"
                            aria-label={`Move option ${option.id} up`}
                            disabled={optionIndex === 0}
                            onClick={() =>
                              updateQuestion(question.id, (item) => {
                                const next = [...item.options]
                                ;[next[optionIndex - 1], next[optionIndex]] = [
                                  next[optionIndex],
                                  next[optionIndex - 1]
                                ]
                                return { ...item, options: next }
                              })
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move option ${option.id} down`}
                            disabled={optionIndex === question.options.length - 1}
                            onClick={() =>
                              updateQuestion(question.id, (item) => {
                                const next = [...item.options]
                                ;[next[optionIndex + 1], next[optionIndex]] = [
                                  next[optionIndex],
                                  next[optionIndex + 1]
                                ]
                                return { ...item, options: next }
                              })
                            }
                          >
                            ↓
                          </button>
                        </div>
                      )}
                    </label>
                  ))}
                </div>
                <div className="generator-settings generator-question-meta">
                  <label>
                    Correct option
                    <select
                      value={question.correctOptionId}
                      disabled={disabled}
                      onChange={(event) =>
                        updateQuestion(question.id, (item) => ({
                          ...item,
                          correctOptionId: event.target.value
                        }))
                      }
                    >
                      {question.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Difficulty
                    <select
                      value={question.difficulty}
                      disabled={disabled}
                      onChange={(event) =>
                        updateQuestion(question.id, (item) => ({
                          ...item,
                          difficulty: event.target.value as AdminQuestionDraft['difficulty']
                        }))
                      }
                    >
                      <option>Easy</option>
                      <option>Medium</option>
                      <option>Hard</option>
                    </select>
                  </label>
                  <label>
                    Topic / learning objective
                    <input
                      maxLength={300}
                      value={question.topic}
                      disabled={disabled}
                      onChange={(event) =>
                        updateQuestion(question.id, (item) => ({
                          ...item,
                          topic: event.target.value
                        }))
                      }
                    />
                  </label>
                </div>
                <label className="generator-block-field">
                  Explanation (instructor review)
                  <textarea
                    maxLength={2_000}
                    rows={2}
                    value={question.explanation}
                    disabled={disabled}
                    onChange={(event) =>
                      updateQuestion(question.id, (item) => ({
                        ...item,
                        explanation: event.target.value
                      }))
                    }
                  />
                </label>
              </article>
            ))}
          </div>
        )}
        {!saved && (
          <div className="generator-actions">
            <button
              className="admin-secondary-button"
              disabled={questions.length >= 20 || generationState === 'generating'}
              onClick={() =>
                setQuestions((current) => [
                  ...current,
                  makeBlankQuestion(current.length + 1, settings.topic)
                ])
              }
            >
              Add question
            </button>
            <button
              className="admin-secondary-button"
              disabled={questions.length === 0}
              onClick={() => {
                setPreview(true)
                setPreviewIndex(0)
              }}
            >
              Preview as student
            </button>
            <button
              className="admin-primary-button"
              disabled={saving || generationState === 'generating' || Boolean(draftError)}
              onClick={() => void saveDraft()}
              title={draftError || undefined}
            >
              {saving ? 'Saving draft…' : 'Save draft'}
            </button>
          </div>
        )}
        {draftError && !saved && questions.length > 0 && (
          <p className="admin-error">Draft cannot be saved: {draftError}</p>
        )}
        {saved && !published && (
          <div className="generator-actions">
            <button
              className="admin-secondary-button"
              onClick={() => {
                setPreview(true)
                setPreviewIndex(0)
              }}
            >
              Preview saved draft
            </button>
            <button className="admin-primary-button" onClick={() => setConfirmPublish(true)}>
              Publish assessment
            </button>
          </div>
        )}
        {published && <p className="admin-success">This assessment is published.</p>}
      </section>

      {preview && questions.length > 0 && (
        <div className="generator-modal-backdrop" role="presentation">
          <section
            className="generator-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="student-preview-title"
          >
            <header>
              <div>
                <span className="admin-eyebrow">STUDENT PREVIEW · {durationMinutes} MINUTES</span>
                <h2 id="student-preview-title">{title || 'Untitled assessment'}</h2>
              </div>
              <button className="admin-secondary-button" onClick={() => setPreview(false)}>
                Return to editor
              </button>
            </header>
            <p>{assessmentInstructions || 'No student instructions provided.'}</p>
            <div className="generator-preview-question">
              <span>
                Question {previewIndex + 1} of {questions.length}
              </span>
              <h3>{questions[previewIndex].prompt || 'Question text is incomplete.'}</h3>
              {questions[previewIndex].options.map((option) => (
                <div className="generator-preview-option" key={option.id}>
                  <span aria-hidden="true" /> {option.text || 'Empty option'}
                </div>
              ))}
            </div>
            <footer>
              <button
                className="admin-secondary-button"
                disabled={previewIndex === 0}
                onClick={() => setPreviewIndex((index) => Math.max(0, index - 1))}
              >
                Previous
              </button>
              <button
                className="admin-primary-button"
                disabled={previewIndex === questions.length - 1}
                onClick={() =>
                  setPreviewIndex((index) => Math.min(questions.length - 1, index + 1))
                }
              >
                Next question
              </button>
            </footer>
          </section>
        </div>
      )}
      {confirmPublish && (
        <div className="generator-modal-backdrop" role="presentation">
          <section
            className="generator-modal generator-confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="publish-confirm-title"
          >
            <h2 id="publish-confirm-title">Confirm publication</h2>
            <p>
              Publish <strong>{title || assessmentId}</strong> with {questions.length} questions for{' '}
              {durationMinutes} minutes? Students will be able to access it through the existing
              assessment service.
            </p>
            <p className="admin-notice">
              This action changes the publication status of this assessment. Verify the student
              preview and all answer keys before continuing.
            </p>
            <footer>
              <button
                className="admin-secondary-button"
                disabled={publishing}
                onClick={() => setConfirmPublish(false)}
              >
                Cancel
              </button>
              <button
                className="admin-primary-button"
                disabled={publishing}
                onClick={() => void publishDraft()}
              >
                {publishing ? 'Publishing…' : 'Confirm and publish'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}
