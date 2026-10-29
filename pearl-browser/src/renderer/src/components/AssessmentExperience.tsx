import { useEffect, useState } from 'react'
import type { AssessmentSession } from '../../../shared/assessment'
import { WebcamMonitor } from './WebcamMonitor'

const initialSession: AssessmentSession = {
  status: 'idle',
  answers: [],
  currentQuestionIndex: 0,
  events: []
}

export function AssessmentExperience({ onExit }: { onExit: () => void }): React.JSX.Element {
  const [session, setSession] = useState(initialSession)
  const [displayName, setDisplayName] = useState('')
  const [demoCode, setDemoCode] = useState('')
  const [otpRequested, setOtpRequested] = useState(false)
  const [remaining, setRemaining] = useState<number | undefined>()
  const [cameraReady, setCameraReady] = useState(false)

  useEffect(() => {
    void window.browser.assessment.getState().then(setSession)
    return window.browser.assessment.onStateChange(setSession)
  }, [])

  useEffect(() => {
    const updateRemaining = (): void => {
      if (!session.deadline) return setRemaining(undefined)
      setRemaining(Math.max(0, Date.parse(session.deadline) - Date.now()))
    }
    updateRemaining()
    const timer = window.setInterval(() => {
      updateRemaining()
    }, 500)
    return () => window.clearInterval(timer)
  }, [session.deadline])

  const configuration = session.configuration
  const question = configuration?.questions[session.currentQuestionIndex]
  const selected = session.answers.find((answer) => answer.questionId === question?.id)?.optionIndex
  const minutes = Math.floor((remaining ?? 0) / 60_000)
  const seconds = Math.floor(((remaining ?? 0) % 60_000) / 1_000)
  const answeredCount = session.answers.length
  const action = (promise: Promise<AssessmentSession>): void => {
    void promise.then(setSession).catch((error: unknown) => {
      setSession((current) => ({
        ...current,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Assessment action failed.'
      }))
    })
  }

  return (
    <main className="assessment-shell">
      <header className="assessment-header">
        <div>
          <span className="assessment-badge">
            {session.configuration?.provider === 'remote-backend'
              ? 'REMOTE MODE · BACKEND'
              : 'DEMO MODE · LOCAL ONLY'}
          </span>
          <h1>Pearl Assessment</h1>
        </div>
        <button className="toolbar-button" onClick={onExit}>
          Return to browser
        </button>
      </header>
      <section className="assessment-card">
        {session.participant &&
          configuration?.provider === 'remote-backend' &&
          (session.status === 'ready' ||
            session.status === 'in_progress' ||
            session.status === 'submitting' ||
            session.status === 'expired') && (
            <WebcamMonitor monitoring={session.status === 'in_progress'} onReady={setCameraReady} />
          )}
        {session.status === 'idle' && (
          <div className="assessment-centered">
            <h2>Demonstration examination</h2>
            <p>
              This is a local prototype. It does not verify identity, prevent cheating, or produce a
              production result.
            </p>
            <button className="go-button" onClick={() => action(window.browser.assessment.start())}>
              Load demo examination
            </button>
          </div>
        )}
        {session.status === 'authenticating' && (
          <p className="assessment-status">Loading demonstration configuration…</p>
        )}
        {session.status === 'ready' && !session.participant && configuration && (
          <form
            className="assessment-form"
            onSubmit={(event) => {
              event.preventDefault()
              action(window.browser.assessment.authenticate(displayName, demoCode))
            }}
          >
            <h2>
              {configuration.provider === 'remote-backend'
                ? 'Participant entry'
                : 'Demo participant entry'}
            </h2>
            <p>
              {configuration.provider === 'remote-backend'
                ? 'Enter a display name to create a remote assessment attempt.'
                : 'Use any display name and the demonstration code '}
              {configuration.provider !== 'remote-backend' && <strong>DEMO</strong>}
            </p>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Display name"
              aria-label="Display name"
            />
            <input
              value={demoCode}
              onChange={(event) => setDemoCode(event.target.value)}
              placeholder={
                configuration.provider === 'remote-backend' ? 'Optional code' : 'Demo code'
              }
              aria-label={
                configuration.provider === 'remote-backend' ? 'Optional code' : 'Demo code'
              }
            />
            {configuration.provider === 'remote-backend' && !otpRequested && (
              <button
                className="go-button"
                type="button"
                onClick={() => {
                  action(window.browser.assessment.requestOtp(displayName))
                  setOtpRequested(true)
                }}
              >
                Email me a verification code
              </button>
            )}
            <button
              className="go-button"
              type="submit"
              disabled={configuration.provider === 'remote-backend' && !otpRequested}
            >
              {configuration.provider === 'remote-backend'
                ? 'Verify email and continue'
                : 'Authenticate demo participant'}
            </button>
          </form>
        )}
        {session.status === 'ready' && session.participant && configuration && (
          <div className="assessment-centered">
            <h2>{configuration.title}</h2>
            <p>{configuration.instructions}</p>
            <button
              className="go-button"
              disabled={configuration.provider === 'remote-backend' && !cameraReady}
              onClick={() => action(window.browser.assessment.begin())}
            >
              Begin examination
            </button>
          </div>
        )}
        {(session.status === 'in_progress' ||
          session.status === 'submitting' ||
          session.status === 'expired') &&
          configuration &&
          question && (
            <div className="assessment-workspace">
              <div className="assessment-progress">
                <span>
                  Question {session.currentQuestionIndex + 1} of {configuration.questions.length}
                </span>
                <strong>
                  {session.status === 'expired'
                    ? 'Time expired'
                    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}
                </strong>
              </div>
              <h2>{question.prompt}</h2>
              <div className="assessment-options">
                {question.options.map((option, index) => (
                  <button
                    key={option.id}
                    className={`assessment-option ${selected === index ? 'selected' : ''}`}
                    disabled={session.status !== 'in_progress'}
                    onClick={() => action(window.browser.assessment.answer(question.id, index))}
                  >
                    <span>{String.fromCharCode(65 + index)}</span>
                    {option.text}
                  </button>
                ))}
              </div>
              <div className="assessment-actions">
                <button
                  className="toolbar-button"
                  disabled={session.status !== 'in_progress' || session.currentQuestionIndex === 0}
                  onClick={() =>
                    action(window.browser.assessment.goToQuestion(session.currentQuestionIndex - 1))
                  }
                >
                  Previous
                </button>
                <span>
                  {answeredCount}/{configuration.questions.length} answered
                </span>
                <button
                  className="toolbar-button"
                  disabled={
                    session.status !== 'in_progress' ||
                    session.currentQuestionIndex === configuration.questions.length - 1
                  }
                  onClick={() =>
                    action(window.browser.assessment.goToQuestion(session.currentQuestionIndex + 1))
                  }
                >
                  Next
                </button>
                <button
                  className="go-button"
                  disabled={session.status !== 'in_progress'}
                  onClick={() => action(window.browser.assessment.submit())}
                >
                  Submit answers
                </button>
              </div>
            </div>
          )}
        {session.status === 'submitted' && (
          <div className="assessment-centered">
            <h2>Submission status</h2>
            <p>{session.submission?.message}</p>
            <button className="go-button" onClick={onExit}>
              Return to browser
            </button>
          </div>
        )}
        {session.status === 'failed' && (
          <div className="assessment-centered">
            <h2>Assessment unavailable</h2>
            <p className="assessment-error">{session.error}</p>
            <button
              className="toolbar-button"
              onClick={() => action(window.browser.assessment.start())}
            >
              Try again
            </button>
          </div>
        )}
      </section>
      <details className="assessment-events">
        <summary>Assessment event record ({session.events.length})</summary>
        {session.events.map((event) => (
          <p key={event.id}>
            <time>{new Date(event.timestamp).toLocaleTimeString()}</time> {event.detail}
          </p>
        ))}
      </details>
    </main>
  )
}
