import { useEffect, useState, useCallback } from 'react'
import type {
  AssessmentActivityEventType,
  AssessmentActivityLogEntry,
  AssessmentSession,
  ProctoringInsightResult
} from '../../../shared/assessment'
import type { BrowserCommand, BrowserState } from '../../../shared/browser'
import { NavigationToolbar } from './NavigationToolbar'
import { TabStrip } from './TabStrip'
import { WebcamMonitor } from './WebcamMonitor'
import { ProctoringInsights } from './ProctoringInsights'

type AssessmentMode = 'choose' | 'live' | 'demo'

const initialSession: AssessmentSession = {
  status: 'idle',
  answers: [],
  currentQuestionIndex: 0,
  events: [],
  activityEvents: []
}

/** Cooldown duration for OTP resend in ms */
const OTP_RESEND_COOLDOWN_MS = 60_000

const activityDescriptions: Record<AssessmentActivityEventType, string> = {
  assessment_started: 'Authenticated assessment attempt started',
  assessment_submitted: 'Assessment submission confirmed',
  navigation_started: 'Navigation started',
  navigation_completed: 'Page loaded',
  search_performed: 'Search submitted from the Pearl address bar',
  ai_assistance_domain_visited: 'Recognized AI assistance site visited',
  tab_created: 'Browser tab created',
  tab_creation_blocked: 'New tab blocked by assessment policy',
  tab_closed: 'Browser tab closed',
  tab_switched: 'Browser tab switched',
  popup_blocked: 'Popup blocked by browser policy',
  navigation_blocked: 'Navigation blocked by assessment policy',
  redirect_observed: 'Website redirected the navigation',
  camera_started: 'Camera monitoring started',
  camera_stopped: 'Camera monitoring stopped',
  camera_permission_denied: 'Camera permission denied',
  camera_unavailable: 'Camera unavailable',
  face_not_detected: 'Face not detected',
  face_detected: 'Face detected',
  multiple_faces_detected: 'Multiple faces detected',
  camera_disconnected: 'Camera disconnected'
}

function describeActivity(entry: AssessmentActivityLogEntry): string {
  if (entry.type === 'navigation_started' && entry.fromHostname && entry.hostname) {
    return `Navigation started from ${entry.fromHostname} to ${entry.hostname}`
  }
  if (
    (entry.type === 'face_not_detected' ||
      entry.type === 'face_detected' ||
      entry.type === 'multiple_faces_detected') &&
    entry.observationDurationMs !== undefined
  ) {
    return `${activityDescriptions[entry.type]} for ${Math.round(entry.observationDurationMs / 1000)} seconds (${entry.observationCount ?? 0} observations)`
  }
  return activityDescriptions[entry.type]
}

interface AssessmentExperienceProps {
  onExit: () => void
  browserState: BrowserState
  onBrowserCommand: (command: BrowserCommand) => void
}

export function AssessmentExperience({
  onExit,
  browserState,
  onBrowserCommand
}: AssessmentExperienceProps): React.JSX.Element {
  const [session, setSession] = useState(initialSession)
  const [mode, setMode] = useState<AssessmentMode>('choose')

  /* OTP authentication state */
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpSending, setOtpSending] = useState(false)
  const [otpVerifying, setOtpVerifying] = useState(false)
  const [otpError, setOtpError] = useState('')
  const [otpSuccess, setOtpSuccess] = useState('')
  const [lastOtpRequestTime, setLastOtpRequestTime] = useState(0)
  const [cooldownRemaining, setCooldownRemaining] = useState(0)

  /* Demo authentication state */
  const [displayName, setDisplayName] = useState('')
  const [demoCode, setDemoCode] = useState('')

  /* General UI state */
  const [remaining, setRemaining] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [beginningExam, setBeginningExam] = useState(false)
  const [proctoringSummary, setProctoringSummary] = useState<ProctoringInsightResult | undefined>()
  const [proctoringSummaryLoading, setProctoringSummaryLoading] = useState(false)

  const handleCameraReadinessChange = useCallback((ready: boolean): void => {
    setCameraReady(ready)
  }, [])

  useEffect(() => {
    setProctoringSummary(undefined)
    setProctoringSummaryLoading(false)
  }, [session.attemptId])

  useEffect(() => {
    void window.browser.assessment.getState().then((nextSession) => {
      setSession(nextSession)
      if (nextSession.configuration?.provider === 'remote-backend') setMode('live')
      else if (nextSession.configuration?.provider === 'local-demo') setMode('demo')
    })
    return window.browser.assessment.onStateChange(setSession)
  }, [])

  /* Timer for assessment countdown */
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

  /* OTP resend cooldown timer */
  useEffect(() => {
    if (lastOtpRequestTime === 0) return
    const update = (): void => {
      const elapsed = Date.now() - lastOtpRequestTime
      const left = Math.max(0, OTP_RESEND_COOLDOWN_MS - elapsed)
      setCooldownRemaining(left)
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [lastOtpRequestTime])

  const configuration = session.configuration
  const activeBrowserTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId)
  const activeBrowserTabIsBookmarked = Boolean(
    activeBrowserTab &&
    browserState.bookmarks.some((bookmark) => bookmark.url === activeBrowserTab.url)
  )
  const question = configuration?.questions[session.currentQuestionIndex]
  const selected = session.answers.find((answer) => answer.questionId === question?.id)?.optionIndex
  const minutes = Math.floor((remaining ?? 0) / 60_000)
  const seconds = Math.floor(((remaining ?? 0) % 60_000) / 1_000)
  const answeredCount = session.answers.length
  const unansweredCount = Math.max(0, (configuration?.questions.length ?? 0) - answeredCount)
  const totalDurationMs = (configuration?.policy.durationMinutes ?? 1) * 60_000
  const timeProgress = Math.min(100, Math.max(0, ((remaining ?? 0) / totalDurationMs) * 100))

  const isLiveMode = mode === 'live'
  const isDemoMode = mode === 'demo'
  useEffect(() => {
    if (
      !isLiveMode ||
      !session.participant ||
      configuration?.provider !== 'remote-backend' ||
      configuration.policy.cameraMonitoring !== true ||
      !['ready', 'authenticating', 'in_progress'].includes(session.status)
    ) {
      setCameraReady(false)
    }
  }, [configuration?.id, configuration?.provider, isLiveMode, session.participant, session.status])
  const activityEvents = session.activityEvents ?? []
  const monitoringActive =
    isLiveMode &&
    session.configuration?.provider === 'remote-backend' &&
    session.status === 'in_progress' &&
    Boolean(session.attemptId)
  const failedActivityEvents = activityEvents.filter((event) => event.storageStatus === 'failed')
  const pendingActivityCount = activityEvents.filter(
    (event) => event.storageStatus === 'pending'
  ).length
  const navigationActivityCount = activityEvents.filter((event) =>
    [
      'navigation_started',
      'navigation_completed',
      'redirect_observed',
      'navigation_blocked'
    ].includes(event.type)
  ).length
  const searchActivityCount = activityEvents.filter(
    (event) => event.type === 'search_performed'
  ).length
  const aiActivityCount = activityEvents.filter(
    (event) => event.type === 'ai_assistance_domain_visited'
  ).length
  const tabActivityCount = activityEvents.filter((event) =>
    ['tab_created', 'tab_creation_blocked', 'tab_closed', 'tab_switched'].includes(event.type)
  ).length

  const action = useCallback((promise: Promise<AssessmentSession>): void => {
    void promise.then(setSession).catch((error: unknown) => {
      setSession((current) => ({
        ...current,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Assessment action failed.'
      }))
    })
  }, [])

  const handleStartLive = useCallback((): void => {
    setMode('live')
    setLoading(true)
    void window.browser.assessment
      .start('live')
      .then((s) => {
        setSession(s)
        setLoading(false)
      })
      .catch((error: unknown) => {
        setSession((current) => ({
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to connect to assessment backend.'
        }))
        setLoading(false)
      })
  }, [])

  const handleStartDemo = useCallback((): void => {
    setMode('demo')
    setLoading(true)
    void window.browser.assessment
      .start('demo')
      .then((s) => {
        setSession(s)
        setLoading(false)
      })
      .catch((error: unknown) => {
        setSession((current) => ({
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Failed to load demo assessment.'
        }))
        setLoading(false)
      })
  }, [])

  const handleSendOtp = useCallback(async (): Promise<void> => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setOtpError('Please enter a valid email address.')
      return
    }
    setOtpSending(true)
    setOtpError('')
    setOtpSuccess('')
    try {
      await window.browser.assessment.requestOtp(trimmedEmail)
      setOtpSent(true)
      setOtpSuccess(
        'A verification code has been sent to your email. Check your inbox and spam folder.'
      )
      setLastOtpRequestTime(Date.now())
    } catch (error) {
      setOtpError(
        error instanceof Error
          ? error.message
          : 'Failed to send verification code. Please try again.'
      )
    } finally {
      setOtpSending(false)
    }
  }, [email])

  const handleVerifyOtp = useCallback(async (): Promise<void> => {
    const trimmedEmail = email.trim()
    const trimmedCode = otpCode.trim()
    if (!trimmedCode || !/^\d{6}$/.test(trimmedCode)) {
      setOtpError('Please enter the 6-digit verification code.')
      return
    }
    setOtpVerifying(true)
    setOtpError('')
    setOtpSuccess('')
    try {
      const nextSession = await window.browser.assessment.authenticate(trimmedEmail, trimmedCode)
      setSession(nextSession)
      setOtpSuccess('Email verified successfully!')
    } catch (error) {
      setOtpError(
        error instanceof Error
          ? error.message
          : 'Verification failed. Please check the code and try again.'
      )
    } finally {
      setOtpVerifying(false)
    }
  }, [email, otpCode])

  const handleResendOtp = useCallback((): void => {
    if (cooldownRemaining > 0) return
    setOtpCode('')
    setOtpError('')
    setOtpSuccess('')
    void handleSendOtp()
  }, [cooldownRemaining, handleSendOtp])

  const handleBeginExam = useCallback((): void => {
    if (!cameraReady || beginningExam) return
    setBeginningExam(true)
    setSession((current) => ({ ...current, error: undefined }))
    void window.browser.assessment
      .begin()
      .then(setSession)
      .catch((error: unknown) => {
        setSession((current) => ({
          ...current,
          error:
            error instanceof Error
              ? error.message
              : 'The exam could not start. Check webcam setup and try again.'
        }))
      })
      .finally(() => setBeginningExam(false))
  }, [beginningExam, cameraReady])

  const handleGenerateProctoringSummary = useCallback((): void => {
    if (!monitoringActive || proctoringSummaryLoading) return
    setProctoringSummaryLoading(true)
    void window.browser.assessment
      .getProctoringInsights()
      .then(setProctoringSummary)
      .catch((error: unknown) => {
        setProctoringSummary({
          status: 'failed',
          message:
            error instanceof Error
              ? error.message
              : 'AI summary could not be loaded. Deterministic review rules remain available.'
        })
      })
      .finally(() => setProctoringSummaryLoading(false))
  }, [monitoringActive, proctoringSummaryLoading])

  const handleBackToChoose = useCallback((): void => {
    void window.browser.assessment.cancel().then(() => {
      setMode('choose')
      setSession(initialSession)
      setEmail('')
      setOtpCode('')
      setOtpSent(false)
      setOtpError('')
      setOtpSuccess('')
      setDisplayName('')
      setDemoCode('')
      setLoading(false)
      setConfirmSubmit(false)
    })
  }, [])

  const cooldownSeconds = Math.ceil(cooldownRemaining / 1000)

  return (
    <main className="assessment-shell">
      {isLiveMode && (
        <div className="assessment-browser-controls" aria-label="Pearl Browser tabs and navigation">
          <TabStrip
            tabs={browserState.tabs}
            activeTabId={browserState.activeTabId}
            onActivate={(tabId) => onBrowserCommand({ type: 'activate-tab', tabId })}
            onClose={(tabId) => onBrowserCommand({ type: 'close-tab', tabId })}
            onNew={() => onBrowserCommand({ type: 'create-tab' })}
          />
          <NavigationToolbar
            key={`${activeBrowserTab?.id ?? 'none'}:${activeBrowserTab?.url ?? ''}`}
            activeTab={activeBrowserTab}
            isBookmarked={activeBrowserTabIsBookmarked}
            assessmentSurface
            onCommand={(type) => onBrowserCommand({ type })}
            onNavigate={(input) => onBrowserCommand({ type: 'navigate', input })}
            onBookmark={() => undefined}
            onPanel={() => undefined}
            onAssessment={() => undefined}
          />
        </div>
      )}
      <header className="assessment-header">
        <div>
          <span className="assessment-badge">
            {isLiveMode
              ? 'LIVE ASSESSMENT · BACKEND'
              : isDemoMode
                ? 'DEMO MODE · LOCAL ONLY'
                : 'PEARL ASSESSMENT'}
          </span>
          <h1>Pearl Browser</h1>
        </div>
        <div className="assessment-header-actions">
          {isLiveMode && (
            <button
              className="toolbar-button proctoring-toggle"
              type="button"
              aria-expanded={activityOpen}
              aria-controls="proctoring-activity-panel"
              onClick={() => setActivityOpen((open) => !open)}
            >
              <span className={`proctoring-toggle-dot ${monitoringActive ? 'is-active' : ''}`} />
              Proctoring Activity
              <span className="proctoring-toggle-count">{activityEvents.length}</span>
            </button>
          )}
          {mode !== 'choose' &&
            session.status !== 'in_progress' &&
            session.status !== 'submitting' && (
              <button className="toolbar-button" onClick={handleBackToChoose}>
                ← Change mode
              </button>
            )}
          <button className="toolbar-button" onClick={onExit}>
            Return to browser
          </button>
        </div>
      </header>
      {isLiveMode &&
        session.participant &&
        configuration?.provider === 'remote-backend' &&
        configuration.policy.cameraMonitoring === true &&
        ['ready', 'authenticating', 'in_progress'].includes(session.status) && (
          <WebcamMonitor
            enabled
            examStarted={session.status === 'in_progress'}
            onReadinessChange={handleCameraReadinessChange}
          />
        )}
      {isLiveMode && activityOpen && (
        <section
          className="proctoring-panel"
          id="proctoring-activity-panel"
          aria-labelledby="proctoring-activity-title"
        >
          <div className="proctoring-panel-heading">
            <div>
              <span className="proctoring-eyebrow">Live attempt activity</span>
              <h2 id="proctoring-activity-title">Proctoring Activity</h2>
            </div>
            <div
              className={`proctoring-status ${monitoringActive ? 'status-active' : 'status-inactive'}`}
              role="status"
            >
              <span /> {monitoringActive ? 'Active' : 'Inactive'}
            </div>
          </div>
          <p className="proctoring-panel-caption">
            Pearl Browser sends activity events to the assessment backend&apos;s in-memory audit
            store; backend restarts clear that log. Address-bar search text is not retained.
            Recognized AI-site visits are informational and do not establish misconduct.
          </p>
          <div className="proctoring-summary" aria-label="Activity event counts">
            <div>
              <strong>{navigationActivityCount}</strong>
              <span>Navigation</span>
            </div>
            <div>
              <strong>{searchActivityCount}</strong>
              <span>Browser searches</span>
            </div>
            <div>
              <strong>{aiActivityCount}</strong>
              <span>Recognized AI sites</span>
            </div>
            <div>
              <strong>{tabActivityCount}</strong>
              <span>Tab activity</span>
            </div>
          </div>
          {failedActivityEvents.length > 0 && (
            <div className="proctoring-log-error" role="alert">
              <strong>
                {failedActivityEvents.length} activity event
                {failedActivityEvents.length === 1 ? '' : 's'} could not be recorded.
              </strong>
              <span>
                {failedActivityEvents.at(-1)?.storageError ??
                  'Check the assessment connection. Failed events remain marked below.'}
              </span>
            </div>
          )}
          {pendingActivityCount > 0 && (
            <p className="proctoring-pending" role="status">
              Recording {pendingActivityCount} activity event{pendingActivityCount === 1 ? '' : 's'}
              …
            </p>
          )}
          {activityEvents.length === 0 ? (
            <div className="proctoring-empty-state">
              <span aria-hidden="true">◷</span>
              <strong>No activity recorded yet</strong>
              <p>
                {monitoringActive
                  ? 'Browser navigation, address-bar searches, recognized AI-site visits, and tab activity will appear here.'
                  : 'Activity logging becomes active when the authenticated live attempt begins.'}
              </p>
            </div>
          ) : (
            <ol
              className="proctoring-timeline"
              aria-label="Chronological activity timeline"
              aria-live="polite"
            >
              {activityEvents.map((entry) => (
                <li
                  key={`${entry.id}-${entry.type}`}
                  className={`proctoring-event event-${entry.severity}`}
                >
                  <span className="proctoring-event-marker" aria-hidden="true">
                    {entry.severity === 'warning' ? '!' : '·'}
                  </span>
                  <div className="proctoring-event-copy">
                    <div className="proctoring-event-title-row">
                      <strong>{describeActivity(entry)}</strong>
                      <span className={`proctoring-kind kind-${entry.severity}`}>
                        {entry.severity === 'warning' ? 'Policy warning' : 'Information'}
                      </span>
                    </div>
                    <div className="proctoring-event-meta">
                      <time dateTime={entry.occurredAt}>
                        {new Date(entry.occurredAt).toLocaleString()}
                      </time>
                      <span>
                        {entry.source === 'assessment'
                          ? 'Assessment'
                          : entry.source === 'webcam'
                            ? 'Webcam'
                            : 'Pearl Browser'}
                      </span>
                      {entry.hostname && <span className="proctoring-host">{entry.hostname}</span>}
                      {typeof entry.confidence === 'number' && (
                        <span>Detector confidence {Math.round(entry.confidence * 100)}%</span>
                      )}
                      <span
                        className={`proctoring-storage storage-${entry.storageStatus}`}
                        title={entry.storageError}
                      >
                        {entry.storageStatus === 'pending'
                          ? 'Recording…'
                          : entry.storageStatus === 'recorded'
                            ? 'Recorded'
                            : 'Not recorded'}
                      </span>
                    </div>
                    {entry.type === 'ai_assistance_domain_visited' && (
                      <span className="proctoring-event-note">
                        A site visit is an observable event, not a finding of misconduct.
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {isLiveMode &&
        session.attemptId &&
        ['in_progress', 'submitting', 'expired', 'submitted'].includes(session.status) && (
          <ProctoringInsights
            events={activityEvents}
            active={monitoringActive}
            summary={proctoringSummary}
            summaryLoading={proctoringSummaryLoading}
            onGenerateSummary={handleGenerateProctoringSummary}
            onOpenTimeline={() => setActivityOpen(true)}
          />
        )}
      <section className="assessment-card">
        {/* ——— Mode selection screen ——— */}
        {mode === 'choose' && (
          <div className="assessment-centered">
            <div className="assessment-brand-icon" aria-hidden="true">
              <span className="assessment-brand-orbit">
                <span className="assessment-brand-core" />
              </span>
            </div>
            <h2>Pearl Assessment Centre</h2>
            <p>Select an assessment mode to continue.</p>
            <div className="assessment-mode-cards">
              <button className="assessment-mode-card mode-live" onClick={handleStartLive}>
                <span className="mode-indicator mode-indicator-live" />
                <strong>Live Assessment</strong>
                <span className="mode-description">
                  Authenticate with email OTP. Load real questions from the configured backend.
                  Results are submitted to the assessment server.
                </span>
              </button>
              <button className="assessment-mode-card mode-demo" onClick={handleStartDemo}>
                <span className="mode-indicator mode-indicator-demo" />
                <strong>Demo Mode</strong>
                <span className="mode-description">
                  Practice with local demonstration questions. No real authentication or backend
                  submission. Data stays on this device.
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ——— Loading state ——— */}
        {(loading || session.status === 'authenticating') && (
          <div className="assessment-centered">
            <div className="assessment-spinner" aria-label="Loading" />
            <p className="assessment-status">
              {session.participant
                ? 'Creating your attempt and loading the published questions…'
                : isLiveMode
                  ? 'Loading the published assessment…'
                  : 'Loading demonstration configuration…'}
            </p>
          </div>
        )}

        {/* ——— LIVE MODE: Email OTP sign-in ——— */}
        {isLiveMode && session.status === 'ready' && !session.participant && configuration && (
          <div className="assessment-otp-flow">
            <div className="assessment-otp-header">
              <div className="assessment-brand-icon assessment-brand-icon-small" aria-hidden="true">
                <span className="assessment-brand-orbit">
                  <span className="assessment-brand-core" />
                </span>
              </div>
              <h2>Assessment Sign-In</h2>
              <p>
                Verify your identity to access <strong>{configuration.title}</strong>. A one-time
                verification code will be sent to your email.
              </p>
            </div>

            {/* OTP error/success messages */}
            {otpError && (
              <div className="assessment-message assessment-message-error" role="alert">
                <span className="message-icon">!</span>
                {otpError}
              </div>
            )}
            {otpSuccess && (
              <div className="assessment-message assessment-message-success" role="status">
                <span className="message-icon">✓</span>
                {otpSuccess}
              </div>
            )}

            {/* Step 1: Email input */}
            <div className="otp-field-group">
              <label className="otp-label" htmlFor="otp-email">
                Email address
              </label>
              <input
                id="otp-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setOtpSent(false)
                  setOtpCode('')
                  setOtpError('')
                  setOtpSuccess('')
                }}
                placeholder="participant@example.com"
                disabled={otpSending || otpVerifying}
                autoComplete="email"
                aria-label="Email address"
              />
            </div>

            {!otpSent ? (
              <button
                className="go-button assessment-otp-button"
                onClick={() => void handleSendOtp()}
                disabled={otpSending || !email.trim()}
              >
                {otpSending ? (
                  <>
                    <span className="button-spinner" aria-hidden="true" /> Sending…
                  </>
                ) : (
                  'Send OTP'
                )}
              </button>
            ) : (
              <>
                {/* Step 2: OTP input */}
                <div className="otp-field-group">
                  <label className="otp-label" htmlFor="otp-code">
                    Verification code
                  </label>
                  <input
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="Enter 6-digit code"
                    disabled={otpVerifying}
                    autoComplete="one-time-code"
                    aria-label="Verification code"
                  />
                </div>

                <button
                  className="go-button assessment-otp-button"
                  onClick={() => void handleVerifyOtp()}
                  disabled={otpVerifying || otpCode.length !== 6}
                >
                  {otpVerifying ? (
                    <>
                      <span className="button-spinner" aria-hidden="true" /> Verifying…
                    </>
                  ) : (
                    'Verify OTP'
                  )}
                </button>

                {/* Resend option */}
                <div className="otp-resend">
                  {cooldownRemaining > 0 ? (
                    <span className="otp-resend-cooldown">
                      Resend available in {cooldownSeconds}s
                    </span>
                  ) : (
                    <button className="text-button" onClick={handleResendOtp} disabled={otpSending}>
                      Resend verification code
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ——— DEMO MODE: Simple entry ——— */}
        {isDemoMode && session.status === 'ready' && !session.participant && configuration && (
          <form
            className="assessment-form"
            onSubmit={(event) => {
              event.preventDefault()
              action(window.browser.assessment.authenticate(displayName, demoCode))
            }}
          >
            <div className="demo-banner" role="status">
              <span className="demo-banner-badge">DEMO MODE</span>
              <span>
                Questions and submissions are local demonstration data. No real backend
                communication occurs.
              </span>
            </div>
            <h2>Demo Participant Entry</h2>
            <p>
              Use any display name and the demonstration code <strong>DEMO</strong>
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
              placeholder="Demo code"
              aria-label="Demo code"
            />
            <button className="go-button" type="submit">
              Authenticate demo participant
            </button>
          </form>
        )}

        {/* ——— Authenticated: Pre-assessment screen ——— */}
        {session.status === 'ready' && session.participant && configuration && (
          <div className="assessment-centered assessment-intro">
            {isLiveMode && (
              <div className="assessment-verified-badge" role="status">
                <span className="verified-icon">✓</span>
                Email verified
              </div>
            )}
            <h2>{configuration.title}</h2>
            <div className="assessment-instructions">
              <span>Instructions</span>
              <p>{configuration.instructions}</p>
            </div>
            <div className="assessment-meta">
              <div className="meta-item">
                <span className="meta-label">Duration</span>
                <span className="meta-value">{configuration.policy.durationMinutes} minutes</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Questions</span>
                <span className="meta-value">
                  {configuration.questionCount ?? configuration.questions.length}
                </span>
              </div>
            </div>
            {session.error && (
              <div className="assessment-message assessment-message-error" role="alert">
                <span className="message-icon">!</span>
                <span>{session.error}</span>
              </div>
            )}
            {session.attemptId && session.deadline && session.status === 'ready' && (
              <div className="assessment-message assessment-message-error" role="status">
                <span className="message-icon">!</span>
                <span>
                  The backend has already started this attempt and its deadline is active. The
                  question-load retry will reuse that attempt; it will not create another one.
                  {remaining !== undefined && ` ${Math.ceil(remaining / 60_000)} minutes remain.`}
                </span>
              </div>
            )}
            <button
              className="go-button assessment-begin-button"
              onClick={handleBeginExam}
              disabled={!cameraReady || beginningExam}
            >
              {beginningExam
                ? 'Starting exam…'
                : session.attemptId
                  ? 'Retry question loading'
                  : cameraReady
                    ? 'Start Exam'
                    : 'Complete webcam setup to continue'}
            </button>
          </div>
        )}

        {/* ——— In-progress: Question view ——— */}
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
                <strong aria-label="Time remaining">
                  {session.status === 'expired'
                    ? 'Time expired'
                    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}
                </strong>
              </div>
              <div
                className="assessment-time-track"
                role="progressbar"
                aria-label="Assessment time remaining"
                aria-valuemin={0}
                aria-valuemax={configuration.policy.durationMinutes * 60}
                aria-valuenow={Math.max(0, Math.floor((remaining ?? 0) / 1000))}
              >
                <span style={{ width: `${timeProgress}%` }} />
              </div>
              <nav className="assessment-question-nav" aria-label="Question navigation">
                {configuration.questions.map((item, index) => {
                  const answered = session.answers.some((answer) => answer.questionId === item.id)
                  return (
                    <button
                      key={item.id}
                      className={`assessment-question-nav-item ${index === session.currentQuestionIndex ? 'current' : ''} ${answered ? 'answered' : ''}`}
                      aria-current={index === session.currentQuestionIndex ? 'step' : undefined}
                      aria-label={`Question ${index + 1}${answered ? ', answered' : ', not answered'}`}
                      disabled={session.status !== 'in_progress'}
                      onClick={() => action(window.browser.assessment.goToQuestion(index))}
                    >
                      <span>{index + 1}</span>
                      <small>{answered ? 'Answered' : 'Open'}</small>
                    </button>
                  )
                })}
              </nav>
              <article className="assessment-question-card">
                <span className="assessment-question-kicker">
                  Question {session.currentQuestionIndex + 1}
                </span>
                <h2>{question.prompt}</h2>
                <div className="assessment-options">
                  {question.options.map((option, index) => (
                    <button
                      key={option.id}
                      className={`assessment-option ${selected === index ? 'selected' : ''}`}
                      aria-pressed={selected === index}
                      disabled={session.status !== 'in_progress'}
                      onClick={() => action(window.browser.assessment.answer(question.id, index))}
                    >
                      <span>{String.fromCharCode(65 + index)}</span>
                      {option.text}
                    </button>
                  ))}
                </div>
              </article>
              {session.error && (
                <div className="assessment-message assessment-message-error" role="alert">
                  <span className="message-icon">!</span>
                  <span>{session.error}</span>
                </div>
              )}
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
                  disabled={session.status !== 'in_progress' && session.status !== 'expired'}
                  onClick={() => {
                    if (session.error || session.status === 'expired') {
                      action(window.browser.assessment.submit())
                    } else {
                      setConfirmSubmit(true)
                    }
                  }}
                >
                  {session.status === 'submitting'
                    ? 'Submitting…'
                    : session.error || session.status === 'expired'
                      ? 'Retry submission'
                      : 'Submit answers'}
                </button>
              </div>
            </div>
          )}

        {/* ——— Submitted ——— */}
        {session.status === 'submitted' && (
          <div className="assessment-centered">
            <div className="assessment-success-icon" aria-hidden="true">
              ✓
            </div>
            <h2>Submission {isLiveMode ? 'Received' : 'Complete'}</h2>
            <div
              className={`submission-status submission-status-${session.submission?.status ?? 'pending'}`}
            >
              {session.submission?.status?.toUpperCase() ?? 'STATUS UNAVAILABLE'}
            </div>
            <p>{session.submission?.message}</p>
            {session.submission?.submittedAt && (
              <p className="submission-timestamp">
                Submitted {new Date(session.submission.submittedAt).toLocaleString()}
              </p>
            )}
            {session.submission?.id && (
              <p className="submission-reference">Reference {session.submission.id}</p>
            )}
            {isDemoMode && (
              <div className="demo-banner" role="status">
                <span className="demo-banner-badge">DEMO MODE</span>
                <span>This was a local demonstration. No real submission was recorded.</span>
              </div>
            )}
            <button className="go-button" onClick={onExit}>
              Return to browser
            </button>
          </div>
        )}

        {/* ——— Failed ——— */}
        {session.status === 'failed' && (
          <div className="assessment-centered">
            <div className="assessment-error-icon" aria-hidden="true">
              !
            </div>
            <h2>{isLiveMode ? 'Live Assessment Error' : 'Assessment Unavailable'}</h2>
            <p className="assessment-error">{session.error}</p>
            {isLiveMode && (
              <p className="assessment-error-hint">
                Check that the assessment backend is running on the configured URL and that Airtable
                and SMTP credentials are valid.
              </p>
            )}
            <div className="assessment-error-actions">
              <button
                className="go-button"
                onClick={() => {
                  if (isLiveMode) handleStartLive()
                  else if (isDemoMode) handleStartDemo()
                  else handleBackToChoose()
                }}
              >
                Try again
              </button>
              <button className="toolbar-button" onClick={handleBackToChoose}>
                Change mode
              </button>
            </div>
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
      {confirmSubmit && configuration && (
        <div className="assessment-confirm-backdrop">
          <section
            className="assessment-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="submit-confirm-title"
            aria-describedby="submit-confirm-description"
          >
            <span className="assessment-dialog-kicker">Final check</span>
            <h2 id="submit-confirm-title">Submit this assessment?</h2>
            <p id="submit-confirm-description">
              {unansweredCount > 0
                ? `${unansweredCount} ${unansweredCount === 1 ? 'question is' : 'questions are'} unanswered. You can return to them before submitting.`
                : 'Your answers will be sent to the assessment server and cannot be changed afterward.'}
            </p>
            <div className="assessment-confirm-actions">
              <button className="toolbar-button" onClick={() => setConfirmSubmit(false)}>
                Review answers
              </button>
              <button
                className="go-button"
                onClick={() => {
                  setConfirmSubmit(false)
                  action(window.browser.assessment.submit())
                }}
              >
                Confirm submission
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
