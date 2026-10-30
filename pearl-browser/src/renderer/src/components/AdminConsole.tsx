import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdminConsoleAssessment,
  AdminConsoleAttempt,
  AdminConsoleData,
  AdminConsoleEvent,
  AdminConsoleQuestion
} from '../../../shared/admin'
import type { ProctoringInsightResult } from '../../../shared/assessment'
import { AdminQuestionGenerator } from './AdminQuestionGenerator'
import { deriveProctoringInsights } from './proctoringRules'

type AdminSection =
  | 'Overview'
  | 'Assessments'
  | 'AI Question Generator'
  | 'Questions'
  | 'Candidates'
  | 'Live Monitoring'
  | 'Attempts and Results'
  | 'Proctoring Events'
  | 'Reports'
  | 'Settings'

const sections: AdminSection[] = [
  'Overview',
  'Assessments',
  'AI Question Generator',
  'Questions',
  'Candidates',
  'Live Monitoring',
  'Attempts and Results',
  'Proctoring Events',
  'Reports',
  'Settings'
]

const authenticationRequiredMessage = 'Administrator authentication is required.'
const sessionExpiredMessage =
  'Your administrator session has expired or is no longer valid. Sign in again.'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The administrator request failed.'
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Not available'
}

function remainingTime(deadline: string, now: number): string {
  const difference = Date.parse(deadline) - now
  if (!Number.isFinite(difference)) return 'Unavailable'
  if (difference <= 0) return 'Deadline reached'
  const minutes = Math.floor(difference / 60_000)
  const seconds = Math.floor((difference % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function monitoringStatus(attempt: AdminConsoleAttempt, now: number): string {
  if (
    attempt.status === 'in_progress' &&
    Number.isFinite(Date.parse(attempt.deadline)) &&
    Date.parse(attempt.deadline) <= now
  ) {
    return 'expired'
  }
  return attempt.status || 'unknown'
}

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function downloadCsv(filename: string, rows: Array<Array<string | number | undefined>>): void {
  const contents = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function assessmentName(id: string, assessments: AdminConsoleAssessment[]): string {
  const assessment = assessments.find((item) => item.id === id)
  return assessment?.title ? `${assessment.title} (${id})` : id || 'Unknown assessment'
}

function EventRows({ events }: { events: AdminConsoleEvent[] }): React.JSX.Element {
  if (events.length === 0) return <p className="admin-empty">No recorded events are available.</p>
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Attempt</th>
            <th>Assessment</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatTime(event.occurredAt)}</td>
              <td>
                <span className="admin-status">{event.type.replaceAll('_', ' ')}</span>
              </td>
              <td>{event.attemptId}</td>
              <td>{event.assessmentId}</td>
              <td>
                {[
                  event.hostname,
                  event.fromHostname ? `from ${event.fromHostname}` : undefined,
                  event.observationDurationMs !== undefined
                    ? `${Math.round(event.observationDurationMs / 1000)}s`
                    : undefined,
                  event.observationCount !== undefined
                    ? `${event.observationCount} observations`
                    : undefined
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AssessmentRows({
  assessments
}: {
  assessments: AdminConsoleAssessment[]
}): React.JSX.Element {
  if (assessments.length === 0) return <p className="admin-empty">No assessment records found.</p>
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Assessment</th>
            <th>ID</th>
            <th>Duration</th>
            <th>Publication</th>
            <th>Questions</th>
            <th>Attempts</th>
          </tr>
        </thead>
        <tbody>
          {assessments.map((assessment) => (
            <tr key={assessment.id}>
              <td>{assessment.title || 'Untitled assessment'}</td>
              <td>{assessment.id || 'Missing ID'}</td>
              <td>
                {assessment.durationMinutes === null ? '—' : `${assessment.durationMinutes} min`}
              </td>
              <td>
                <span className={`admin-status ${assessment.isPublished ? 'positive' : ''}`}>
                  {assessment.isPublished ? 'Published' : 'Unpublished'}
                </span>
              </td>
              <td>{assessment.questionCount}</td>
              <td>{assessment.attemptCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QuestionRows({ questions }: { questions: AdminConsoleQuestion[] }): React.JSX.Element {
  if (questions.length === 0) return <p className="admin-empty">No question records found.</p>
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Question</th>
            <th>Assessment</th>
            <th>Order</th>
            <th>State</th>
            <th>Answer options</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question) => (
            <tr key={question.recordId}>
              <td>
                <strong>{question.id || 'Missing ID'}</strong>
                {!question.id && (
                  <span className="admin-cell-detail">Airtable record: {question.recordId}</span>
                )}
                <span className="admin-cell-detail">{question.prompt || 'No question text'}</span>
              </td>
              <td>{question.assessmentId || 'Unknown'}</td>
              <td>{question.order ?? '—'}</td>
              <td>
                <span
                  className={`admin-status ${question.validationError ? 'invalid' : ''}`}
                  title={question.validationError}
                >
                  {question.validationError ? 'Invalid' : question.isActive ? 'Active' : 'Inactive'}
                </span>
                {question.validationError && (
                  <span className="admin-question-validation">{question.validationError}</span>
                )}
              </td>
              <td>
                {question.validationError
                  ? 'Options unavailable until corrected'
                  : question.options.map((option) => `${option.id}: ${option.text}`).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AttemptRows({
  attempts,
  assessments,
  now,
  liveOnly = false
}: {
  attempts: AdminConsoleAttempt[]
  assessments: AdminConsoleAssessment[]
  now: number
  liveOnly?: boolean
}): React.JSX.Element {
  const visible = liveOnly
    ? attempts.filter((attempt) => attempt.status === 'in_progress')
    : attempts
  if (visible.length === 0) {
    return (
      <p className="admin-empty">
        {liveOnly ? 'No active attempts are recorded.' : 'No attempts found.'}
      </p>
    )
  }
  return (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Participant</th>
            <th>Assessment</th>
            <th>Attempt</th>
            <th>Status</th>
            <th>Started</th>
            {liveOnly && (
              <>
                <th>Time remaining</th>
                <th>Camera status</th>
              </>
            )}
            {!liveOnly && <th>Submitted</th>}
            {!liveOnly && <th>Submission reference</th>}
            {liveOnly && <th>Latest activity</th>}
          </tr>
        </thead>
        <tbody>
          {visible.map((attempt) => (
            <tr key={attempt.id}>
              <td>
                {attempt.participantDisplayName || 'Participant'}
                <span className="admin-cell-detail">
                  {attempt.participantEmail || 'Email unavailable'}
                </span>
              </td>
              <td>{assessmentName(attempt.assessmentId, assessments)}</td>
              <td>{attempt.id || 'Missing ID'}</td>
              <td>
                <span
                  className={`admin-status ${attempt.status === 'submitted' ? 'positive' : ''}`}
                >
                  {attempt.status || 'Unknown'}
                </span>
              </td>
              <td>{formatTime(attempt.startedAt)}</td>
              {liveOnly && (
                <>
                  <td>{remainingTime(attempt.deadline, now)}</td>
                  <td>{attempt.cameraStatus || 'Not reported'}</td>
                </>
              )}
              {!liveOnly && <td>{attempt.submittedAt ? formatTime(attempt.submittedAt) : '—'}</td>}
              {!liveOnly && <td>{attempt.submissionId || '—'}</td>}
              {liveOnly && (
                <td>
                  {attempt.latestActivity
                    ? `${attempt.latestActivity.type.replaceAll('_', ' ')} · ${formatTime(attempt.latestActivity.occurredAt)}`
                    : 'No activity recorded'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AdminConsole({ onExit }: { onExit: () => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [otpRequested, setOtpRequested] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [data, setData] = useState<AdminConsoleData>()
  const [section, setSection] = useState<AdminSection>('Overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [assessmentFilter, setAssessmentFilter] = useState('all')
  const [publicationFilter, setPublicationFilter] = useState('all')
  const [now, setNow] = useState(() => Date.now())
  const [insightAttemptId, setInsightAttemptId] = useState('')
  const [insightResult, setInsightResult] = useState<ProctoringInsightResult>()
  const [insightLoading, setInsightLoading] = useState(false)
  const [monitoringStatusFilter, setMonitoringStatusFilter] = useState('all')
  const [monitoringSort, setMonitoringSort] = useState<'newest' | 'oldest' | 'name' | 'status'>(
    'newest'
  )
  const [monitoringPage, setMonitoringPage] = useState(0)
  const [selectedAttemptId, setSelectedAttemptId] = useState('')
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState('')
  const [connectionState, setConnectionState] = useState<'connected' | 'disconnected'>(
    'disconnected'
  )
  const refreshInProgress = useRef(false)
  const authEpoch = useRef(0)
  const [serverClockAnchor, setServerClockAnchor] = useState<{
    serverTime: number
    clientTime: number
  }>()

  const refresh = useCallback(async (background = false): Promise<void> => {
    if (refreshInProgress.current) return
    refreshInProgress.current = true
    const requestEpoch = authEpoch.current
    if (!background) {
      setLoading(true)
      setError('')
    }
    try {
      const current = await window.browser.admin.getData()
      if (requestEpoch !== authEpoch.current) return
      setData(current)
      setAuthenticated(true)
      setLastSuccessfulRefresh(current.generatedAt)
      const serverTime = Date.parse(current.generatedAt)
      if (Number.isFinite(serverTime)) {
        setServerClockAnchor({ serverTime, clientTime: Date.now() })
      }
      setConnectionState('connected')
    } catch (requestError) {
      if (requestEpoch !== authEpoch.current) return
      const requestMessage = messageOf(requestError)
      setConnectionState('disconnected')
      if (
        requestMessage === sessionExpiredMessage ||
        requestMessage === authenticationRequiredMessage
      ) {
        authEpoch.current += 1
        setAuthenticated(false)
        setData(undefined)
        setSelectedAttemptId('')
        setOtpRequested(false)
        setCode('')
        setError(sessionExpiredMessage)
      } else if (!background) {
        setError(requestMessage)
      }
    } finally {
      refreshInProgress.current = false
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const resumed = await window.browser.admin.resume()
        if (!active || !resumed) return
        setAuthenticated(true)
        await refresh()
      } catch (requestError) {
        if (active) setError(messageOf(requestError))
      }
    })()
    return () => {
      active = false
    }
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!authenticated) return
    const interval = section === 'Live Monitoring' ? 7_000 : 20_000
    const timer = window.setInterval(() => void refresh(true), interval)
    return () => window.clearInterval(timer)
  }, [authenticated, refresh, section])

  const candidates = useMemo(() => {
    if (!data) return []
    const byEmail = new Map<string, { email: string; attempts: AdminConsoleAttempt[] }>()
    for (const attempt of data.attempts) {
      const key = attempt.participantEmail.trim().toLowerCase()
      if (!key) continue
      const candidate = byEmail.get(key) ?? { email: key, attempts: [] }
      candidate.attempts.push(attempt)
      byEmail.set(key, candidate)
    }
    return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
  }, [data])

  const filteredAttempts = useMemo(() => {
    if (!data) return []
    const query = search.trim().toLowerCase()
    return data.attempts.filter((attempt) => {
      if (assessmentFilter !== 'all' && attempt.assessmentId !== assessmentFilter) return false
      return (
        !query ||
        [
          attempt.id,
          attempt.assessmentId,
          attempt.participantDisplayName,
          attempt.participantEmail,
          attempt.status
        ].some((value) => value.toLowerCase().includes(query))
      )
    })
  }, [assessmentFilter, data, search])

  const filteredAssessments = useMemo(() => {
    if (!data) return []
    const query = search.trim().toLowerCase()
    return data.assessments.filter((assessment) => {
      if (publicationFilter === 'published' && !assessment.isPublished) return false
      if (publicationFilter === 'unpublished' && assessment.isPublished) return false
      return !query || `${assessment.id} ${assessment.title}`.toLowerCase().includes(query)
    })
  }, [data, publicationFilter, search])

  const filteredQuestions = useMemo(() => {
    if (!data) return []
    const query = search.trim().toLowerCase()
    return data.questions.filter((question) => {
      if (assessmentFilter !== 'all' && question.assessmentId !== assessmentFilter) return false
      return (
        !query ||
        `${question.recordId} ${question.id} ${question.assessmentId} ${question.prompt}`
          .toLowerCase()
          .includes(query)
      )
    })
  }, [assessmentFilter, data, search])

  const filteredCandidates = useMemo(
    () =>
      candidates
        .map((candidate) => ({
          ...candidate,
          attempts: candidate.attempts.filter(
            (attempt) => assessmentFilter === 'all' || attempt.assessmentId === assessmentFilter
          )
        }))
        .filter(
          (candidate) =>
            candidate.attempts.length > 0 &&
            (!search.trim() || candidate.email.includes(search.trim().toLowerCase()))
        ),
    [assessmentFilter, candidates, search]
  )

  const filteredEvents = useMemo(() => {
    if (!data) return []
    const query = search.trim().toLowerCase()
    return data.events
      .filter((event) => assessmentFilter === 'all' || event.assessmentId === assessmentFilter)
      .filter(
        (event) =>
          !query ||
          [
            event.type,
            event.attemptId,
            event.assessmentId,
            event.hostname ?? '',
            event.fromHostname ?? ''
          ].some((value) => value.toLowerCase().includes(query))
      )
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
  }, [assessmentFilter, data, search])

  const insightAttemptEvents = useMemo(
    () => data?.events.filter((event) => event.attemptId === insightAttemptId) ?? [],
    [data, insightAttemptId]
  )
  const insightReviewLevel = useMemo(
    () =>
      deriveProctoringInsights(
        insightAttemptEvents.map((event) => ({ ...event, storageStatus: 'recorded' as const }))
      ).level,
    [insightAttemptEvents]
  )
  const monitoringNow = serverClockAnchor
    ? serverClockAnchor.serverTime + (now - serverClockAnchor.clientTime)
    : now
  const monitoringAttempts = useMemo(() => {
    if (!data) return []
    const filtered = filteredAttempts.filter(
      (attempt) =>
        monitoringStatusFilter === 'all' ||
        monitoringStatus(attempt, monitoringNow) === monitoringStatusFilter
    )
    return filtered.sort((left, right) => {
      if (monitoringSort === 'name') {
        return left.participantDisplayName.localeCompare(right.participantDisplayName)
      }
      if (monitoringSort === 'status') {
        return monitoringStatus(left, monitoringNow).localeCompare(
          monitoringStatus(right, monitoringNow)
        )
      }
      const difference = Date.parse(left.startedAt) - Date.parse(right.startedAt)
      return monitoringSort === 'oldest' ? difference : -difference
    })
  }, [data, filteredAttempts, monitoringNow, monitoringSort, monitoringStatusFilter])
  const monitoringAlerts = useMemo(() => {
    if (!data) return []
    const eventsByAttempt = new Map<string, AdminConsoleEvent[]>()
    for (const event of data.events) {
      const attemptEvents = eventsByAttempt.get(event.attemptId) ?? []
      attemptEvents.push(event)
      eventsByAttempt.set(event.attemptId, attemptEvents)
    }
    return data.attempts.flatMap((attempt) => {
      if (
        monitoringStatus(attempt, serverClockAnchor?.serverTime ?? monitoringNow) !== 'in_progress'
      ) {
        return []
      }
      const events = (eventsByAttempt.get(attempt.id) ?? []).map((event) => ({
        ...event,
        storageStatus: 'recorded' as const
      }))
      const review = deriveProctoringInsights(events)
      return review.level === 'Low' ? [] : [{ attempt, review }]
    })
  }, [data, monitoringNow, serverClockAnchor])
  const activeParticipants = useMemo(() => {
    if (!data) return 0
    return new Set(
      data.attempts
        .filter(
          (attempt) =>
            monitoringStatus(attempt, monitoringNow) === 'in_progress' &&
            (attempt.participantEmail || attempt.participantDisplayName || attempt.id)
        )
        .map((attempt) =>
          (attempt.participantEmail || attempt.participantDisplayName || attempt.id)
            .trim()
            .toLowerCase()
        )
    ).size
  }, [data, monitoringNow])
  const selectedAttempt = data?.attempts.find((attempt) => attempt.id === selectedAttemptId)
  const selectedAttemptEvents = useMemo(
    () =>
      data?.events
        .filter((event) => event.attemptId === selectedAttemptId)
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)) ?? [],
    [data, selectedAttemptId]
  )
  const selectedAttemptReview = useMemo(
    () =>
      deriveProctoringInsights(
        selectedAttemptEvents.map((event) => ({ ...event, storageStatus: 'recorded' as const }))
      ),
    [selectedAttemptEvents]
  )
  const monitoringPageSize = 10
  const pageCount = Math.max(1, Math.ceil(monitoringAttempts.length / monitoringPageSize))
  const currentMonitoringPage = Math.min(monitoringPage, pageCount - 1)
  const visibleMonitoringAttempts = monitoringAttempts.slice(
    currentMonitoringPage * monitoringPageSize,
    (currentMonitoringPage + 1) * monitoringPageSize
  )

  const requestOtp = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError('')
    setNotice('')
    setLoading(true)
    try {
      await window.browser.admin.requestOtp(email.trim())
      setOtpRequested(true)
      setNotice('If this address is authorized, a verification code will be sent.')
    } catch (requestError) {
      setError(messageOf(requestError))
    } finally {
      setLoading(false)
    }
  }

  const verifyOtp = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError('')
    setNotice('')
    setLoading(true)
    try {
      await window.browser.admin.verifyOtp(email.trim(), code.trim())
      setCode('')
      setAuthenticated(true)
      await refresh()
    } catch (requestError) {
      setError(messageOf(requestError))
    } finally {
      setLoading(false)
    }
  }

  const logout = async (): Promise<void> => {
    setError('')
    try {
      await window.browser.admin.logout()
      authEpoch.current += 1
      setAuthenticated(false)
      setData(undefined)
      setSelectedAttemptId('')
      setOtpRequested(false)
      setConnectionState('disconnected')
      setNotice('You have been signed out.')
    } catch (requestError) {
      setError(messageOf(requestError))
      authEpoch.current += 1
      setAuthenticated(false)
      setData(undefined)
      setSelectedAttemptId('')
      setConnectionState('disconnected')
    }
  }

  const loadInsights = async (): Promise<void> => {
    const attempt = data?.attempts.find((item) => item.id === insightAttemptId)
    if (!attempt) return
    setInsightLoading(true)
    setInsightResult(undefined)
    setError('')
    try {
      setInsightResult(await window.browser.admin.getInsights(attempt.id, attempt.assessmentId))
    } catch (requestError) {
      setError(messageOf(requestError))
    } finally {
      setInsightLoading(false)
    }
  }

  const exportCsv = async (targetId: 'attempts' | 'events'): Promise<void> => {
    if (!data) return
    setLoading(true)
    setError('')
    try {
      await window.browser.admin.recordExport(targetId)
      const sourceRows: Array<Array<string | number | undefined>> =
        targetId === 'attempts'
          ? [
              [
                'Attempt ID',
                'Assessment ID',
                'Participant',
                'Participant email',
                'Status',
                'Started at',
                'Deadline',
                'Submitted at'
              ],
              ...filteredAttempts.map((attempt) => [
                attempt.id,
                attempt.assessmentId,
                attempt.participantDisplayName,
                attempt.participantEmail,
                attempt.status,
                attempt.startedAt,
                attempt.deadline,
                attempt.submittedAt
              ])
            ]
          : [
              [
                'Event ID',
                'Type',
                'Occurred at',
                'Attempt ID',
                'Assessment ID',
                'Hostname',
                'From hostname',
                'Observation count',
                'Duration ms',
                'Confidence'
              ],
              ...filteredEvents.map((event) => [
                event.id,
                event.type,
                event.occurredAt,
                event.attemptId,
                event.assessmentId,
                event.hostname,
                event.fromHostname,
                event.observationCount,
                event.observationDurationMs,
                event.confidence
              ])
            ]
      downloadCsv(`pearl-${targetId}-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Source', 'Pearl Browser configured backend'],
        ['Generated at', data.generatedAt],
        ...sourceRows
      ])
      setNotice('CSV exported. The administrator action was recorded in the backend audit log.')
    } catch (requestError) {
      setError(messageOf(requestError))
    } finally {
      setLoading(false)
    }
  }

  const renderSection = (): React.JSX.Element => {
    if (!data) return <p className="admin-empty">Dashboard data is not available.</p>
    switch (section) {
      case 'Overview':
        return (
          <>
            {data.questionValidationErrors.length > 0 && (
              <div className="admin-question-validation-summary" role="alert">
                <strong>
                  {data.questionValidationErrors.length} invalid question records require review.
                </strong>
                <span>
                  Assessment overview data is available. Review the Questions section for record
                  identifiers and validation details.
                </span>
              </div>
            )}
            <div className="admin-metrics">
              {[
                ['Assessments', data.metrics.totalAssessments],
                ['Published', data.metrics.publishedAssessments],
                ['Candidates (attempt records)', data.metrics.totalCandidates],
                ['Active attempts', data.metrics.activeAttempts],
                ['Submitted', data.metrics.submittedAttempts],
                ['Expired', data.metrics.expiredAttempts],
                ['Failed', data.metrics.failedAttempts]
              ].map(([label, value]) => (
                <article className="admin-metric" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </article>
              ))}
            </div>
            <section className="admin-card">
              <div className="admin-card-heading">
                <h2>Assessment activity</h2>
                <span>From configured Airtable records</span>
              </div>
              <AssessmentRows assessments={data.assessments.slice(0, 8)} />
            </section>
            <section className="admin-card">
              <div className="admin-card-heading">
                <h2>Live examinations</h2>
                <span>Server-derived deadlines</span>
              </div>
              <AttemptRows
                attempts={data.attempts}
                assessments={data.assessments}
                now={now}
                liveOnly
              />
            </section>
            <section className="admin-card">
              <div className="admin-card-heading">
                <h2>Recent proctoring events</h2>
              </div>
              <EventRows
                events={[...data.events]
                  .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
                  .slice(0, 10)}
              />
            </section>
          </>
        )
      case 'Assessments':
        return (
          <section className="admin-card">
            <p className="admin-notice">
              Existing assessment records are read-only here. New assessments can be created as
              unpublished drafts in AI Question Generator and published only after explicit review.
            </p>
            <AssessmentRows assessments={filteredAssessments} />
          </section>
        )
      case 'AI Question Generator':
        return <AdminQuestionGenerator assessments={data.assessments} onSaved={refresh} />
      case 'Questions':
        return (
          <section className="admin-card">
            <p className="admin-notice">
              Read-only question bank. Correct-answer fields are not returned by the dashboard API.
            </p>
            {data.questionValidationErrors.length > 0 && (
              <div className="admin-question-validation-summary" role="alert">
                <strong>
                  {data.questionValidationErrors.length} invalid question records need correction.
                </strong>
                <span>
                  These records are shown below with their Question ID, Assessment ID, and
                  validation error. If identifiers are missing, the Airtable record ID is shown for
                  lookup. Correct the existing Airtable record; dashboard loading does not change
                  it.
                </span>
              </div>
            )}
            <QuestionRows questions={filteredQuestions} />
          </section>
        )
      case 'Candidates':
        return (
          <section className="admin-card">
            <p className="admin-notice">
              Candidate identity is derived from attempt records. The current backend has no
              enrollment eligibility or identity-verification fields.
            </p>
            {filteredCandidates.length === 0 ? (
              <p className="admin-empty">No participant email records match these filters.</p>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Participant email</th>
                      <th>Attempts</th>
                      <th>Assessments</th>
                      <th>Latest status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCandidates.map((candidate) => {
                      const latest = [...candidate.attempts].sort(
                        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
                      )[0]
                      return (
                        <tr key={candidate.email}>
                          <td>{candidate.email}</td>
                          <td>{candidate.attempts.length}</td>
                          <td>
                            {[
                              ...new Set(candidate.attempts.map((attempt) => attempt.assessmentId))
                            ].join(', ')}
                          </td>
                          <td>{latest?.status || 'Unknown'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      case 'Live Monitoring':
        return (
          <>
            <section className="admin-monitoring-metrics" aria-label="Live examination metrics">
              <article className="admin-metric">
                <span>Active attempts</span>
                <strong>{data.metrics.activeAttempts}</strong>
              </article>
              <article className="admin-metric">
                <span>Active participants</span>
                <strong>{activeParticipants}</strong>
              </article>
              <article className="admin-metric">
                <span>Submitted attempts</span>
                <strong>{data.metrics.submittedAttempts}</strong>
              </article>
              <article className="admin-metric">
                <span>Active attempts with review signals</span>
                <strong>{monitoringAlerts.length}</strong>
              </article>
            </section>
            <section className="admin-card">
              <div className="admin-card-heading">
                <h2>Live examination control center</h2>
                <span
                  className={`admin-connection-state ${connectionState}`}
                  role="status"
                  aria-live="polite"
                >
                  <i aria-hidden="true" />
                  {connectionState === 'connected' ? 'Connected' : 'Reconnecting'}
                  {lastSuccessfulRefresh && ` · Updated ${formatTime(lastSuccessfulRefresh)}`}
                </span>
              </div>
              <p className="admin-notice">
                Real attempt and recorded-event data refresh every 7 seconds while this view is
                open. Time remaining is calculated from the server-provided deadline. No camera feed
                or recording is available here.
              </p>

              {monitoringAlerts.length > 0 ? (
                <div className="admin-monitoring-alerts" aria-label="Deterministic review alerts">
                  {monitoringAlerts.map(({ attempt, review }) => (
                    <article
                      className={`admin-monitoring-alert ${review.level.toLowerCase()}`}
                      key={attempt.id}
                    >
                      <div>
                        <strong>
                          {review.level} review ·{' '}
                          {attempt.participantDisplayName ||
                            attempt.participantEmail ||
                            'Participant'}
                        </strong>
                        <span>
                          {assessmentName(attempt.assessmentId, data.assessments)} · Attempt{' '}
                          {attempt.id}
                        </span>
                        <small>
                          {review.indicators.map((indicator) => indicator.title).join(' · ')}
                        </small>
                      </div>
                      <button
                        className="admin-secondary-button"
                        onClick={() => setSelectedAttemptId(attempt.id)}
                      >
                        Review details
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="admin-empty">No recorded events currently meet review thresholds.</p>
              )}

              <div className="admin-monitoring-controls">
                <label>
                  Status
                  <select
                    aria-label="Filter attempts by status"
                    value={monitoringStatusFilter}
                    onChange={(event) => {
                      setMonitoringStatusFilter(event.target.value)
                      setMonitoringPage(0)
                    }}
                  >
                    <option value="all">All statuses</option>
                    <option value="in_progress">In progress</option>
                    <option value="expired">Deadline reached</option>
                    <option value="submitted">Submitted</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
                <label>
                  Sort by
                  <select
                    aria-label="Sort monitoring attempts"
                    value={monitoringSort}
                    onChange={(event) => {
                      setMonitoringSort(event.target.value as typeof monitoringSort)
                      setMonitoringPage(0)
                    }}
                  >
                    <option value="newest">Most recently started</option>
                    <option value="oldest">Oldest started</option>
                    <option value="name">Participant name</option>
                    <option value="status">Status</option>
                  </select>
                </label>
                <span>{monitoringAttempts.length} matching attempts</span>
              </div>

              {monitoringAttempts.length === 0 ? (
                <p className="admin-empty">No attempts match the selected filters.</p>
              ) : (
                <>
                  <div className="admin-table-scroll">
                    <table className="admin-table admin-monitoring-table">
                      <thead>
                        <tr>
                          <th>Participant</th>
                          <th>Assessment / attempt</th>
                          <th>Status</th>
                          <th>Time remaining</th>
                          <th>Question progress</th>
                          <th>Camera</th>
                          <th>Latest recorded activity</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleMonitoringAttempts.map((attempt) => {
                          const status = monitoringStatus(attempt, monitoringNow)
                          const answered = attempt.answeredQuestionCount
                          return (
                            <tr key={attempt.id}>
                              <td>
                                {attempt.participantDisplayName || 'Participant'}
                                <span className="admin-cell-detail">
                                  {attempt.participantEmail || 'Email unavailable'}
                                </span>
                              </td>
                              <td>
                                {assessmentName(attempt.assessmentId, data.assessments)}
                                <span className="admin-cell-detail">Attempt {attempt.id}</span>
                              </td>
                              <td>
                                <span className={`admin-status ${status}`}>
                                  {status.replaceAll('_', ' ')}
                                </span>
                              </td>
                              <td>
                                {status === 'in_progress'
                                  ? remainingTime(attempt.deadline, monitoringNow)
                                  : status === 'expired'
                                    ? 'Deadline reached'
                                    : '—'}
                              </td>
                              <td>
                                {answered === null
                                  ? status === 'in_progress'
                                    ? 'Unavailable until submission'
                                    : 'Saved answer count unavailable'
                                  : `${answered} / ${attempt.totalQuestionCount}`}
                              </td>
                              <td>{attempt.cameraStatus || 'Not reported'}</td>
                              <td>
                                {attempt.latestActivity
                                  ? `${attempt.latestActivity.type.replaceAll('_', ' ')} · ${formatTime(attempt.latestActivity.occurredAt)}`
                                  : 'No activity recorded'}
                              </td>
                              <td>
                                <button
                                  className="admin-secondary-button"
                                  onClick={() => setSelectedAttemptId(attempt.id)}
                                >
                                  Open
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {pageCount > 1 && (
                    <div className="admin-monitoring-pagination">
                      <button
                        className="admin-secondary-button"
                        disabled={currentMonitoringPage === 0}
                        onClick={() => setMonitoringPage((page) => page - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        Page {currentMonitoringPage + 1} of {pageCount}
                      </span>
                      <button
                        className="admin-secondary-button"
                        disabled={currentMonitoringPage >= pageCount - 1}
                        onClick={() => setMonitoringPage((page) => page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}

              {selectedAttempt && (
                <section className="admin-monitoring-detail" aria-label="Selected attempt details">
                  <div className="admin-card-heading">
                    <div>
                      <h2>{selectedAttempt.participantDisplayName || 'Participant'}</h2>
                      <span>
                        {selectedAttempt.participantEmail || 'Email unavailable'} · Attempt{' '}
                        {selectedAttempt.id}
                      </span>
                    </div>
                    <button
                      className="admin-secondary-button"
                      onClick={() => setSelectedAttemptId('')}
                    >
                      Close details
                    </button>
                  </div>
                  <div className="admin-monitoring-detail-grid">
                    <article>
                      <strong>Assessment</strong>
                      <span>{assessmentName(selectedAttempt.assessmentId, data.assessments)}</span>
                    </article>
                    <article>
                      <strong>Started</strong>
                      <span>{formatTime(selectedAttempt.startedAt)}</span>
                    </article>
                    <article>
                      <strong>Server deadline</strong>
                      <span>{formatTime(selectedAttempt.deadline)}</span>
                    </article>
                    <article>
                      <strong>Time remaining</strong>
                      <span>{remainingTime(selectedAttempt.deadline, monitoringNow)}</span>
                    </article>
                    <article>
                      <strong>Answer progress</strong>
                      <span>
                        {selectedAttempt.answeredQuestionCount === null
                          ? monitoringStatus(selectedAttempt, monitoringNow) === 'in_progress'
                            ? 'Not synchronized during an active attempt; saved on submission.'
                            : 'Saved answer count is unavailable for this attempt.'
                          : `${selectedAttempt.answeredQuestionCount} of ${selectedAttempt.totalQuestionCount} saved answers`}
                      </span>
                    </article>
                    <article>
                      <strong>Camera status</strong>
                      <span>{selectedAttempt.cameraStatus || 'Not reported'}</span>
                    </article>
                  </div>

                  <div className="admin-monitoring-review">
                    <div>
                      <strong>Deterministic review level: {selectedAttemptReview.level}</strong>
                      <span>
                        Calculated from recorded events using the existing review rules. This is an
                        indicator for human review, not a misconduct finding.
                      </span>
                    </div>
                    {data.activityLogAvailable && (
                      <button
                        className="admin-secondary-button"
                        onClick={() => {
                          setInsightAttemptId(selectedAttempt.id)
                          setInsightResult(undefined)
                          setSection('Proctoring Events')
                        }}
                      >
                        Open AI summary
                      </button>
                    )}
                  </div>
                  {selectedAttemptReview.indicators.map((indicator) => (
                    <article className="admin-monitoring-indicator" key={indicator.id}>
                      <strong>{indicator.title}</strong>
                      <span>{indicator.detail}</span>
                      <small>
                        Evidence: {indicator.events.map((event) => event.id).join(', ')}
                      </small>
                    </article>
                  ))}

                  <h3>Recorded event timeline</h3>
                  <p className="admin-notice">
                    Events come from the configured backend audit log. The current event schema does
                    not record the originating source, so no source is inferred.
                  </p>
                  {selectedAttemptEvents.length === 0 ? (
                    <p className="admin-empty">No recorded event timeline is available.</p>
                  ) : (
                    <ol className="admin-monitoring-timeline">
                      {selectedAttemptEvents.map((event) => (
                        <li key={event.id}>
                          <time>{formatTime(event.occurredAt)}</time>
                          <div>
                            <strong>{event.type.replaceAll('_', ' ')}</strong>
                            <span>
                              Event {event.id}
                              {event.hostname ? ` · Host ${event.hostname}` : ''}
                              {event.fromHostname ? ` · From ${event.fromHostname}` : ''}
                              {event.observationCount !== undefined
                                ? ` · ${event.observationCount} observations`
                                : ''}
                              {event.observationDurationMs !== undefined
                                ? ` · ${event.observationDurationMs} ms`
                                : ''}
                              {event.confidence !== undefined
                                ? ` · confidence ${event.confidence}`
                                : ''}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
            </section>
          </>
        )
      case 'Attempts and Results':
        return (
          <section className="admin-card">
            <p className="admin-notice">
              Scores are unavailable because the current backend does not calculate or persist
              grading results.
            </p>
            <AttemptRows attempts={filteredAttempts} assessments={data.assessments} now={now} />
          </section>
        )
      case 'Proctoring Events':
        return (
          <section className="admin-card">
            {!data.activityLogAvailable ? (
              <p className="admin-notice">Activity event storage is not configured.</p>
            ) : (
              <>
                <div className="admin-insight-controls">
                  <label htmlFor="admin-insight-attempt">AI summary for an attempt</label>
                  <select
                    id="admin-insight-attempt"
                    value={insightAttemptId}
                    onChange={(event) => {
                      setInsightAttemptId(event.target.value)
                      setInsightResult(undefined)
                    }}
                  >
                    <option value="">Select an attempt</option>
                    {data.attempts.map((attempt) => (
                      <option key={attempt.id} value={attempt.id}>
                        {attempt.participantEmail || attempt.participantDisplayName || attempt.id} ·{' '}
                        {attempt.id}
                      </option>
                    ))}
                  </select>
                  <button
                    className="admin-secondary-button"
                    onClick={() => void loadInsights()}
                    disabled={!insightAttemptId || insightLoading}
                  >
                    {insightLoading ? 'Reviewing…' : 'Generate summary'}
                  </button>
                </div>
                {insightResult && (
                  <div className="admin-insight-result">
                    <strong>{insightResult.status.replaceAll('_', ' ')}</strong>
                    <p>{insightResult.message}</p>
                    {insightResult.status === 'available' && (
                      <>
                        <article>
                          <strong>Rule-based review level: {insightReviewLevel}</strong>
                          <small>
                            Calculated independently from recorded events; the AI summary cannot
                            change this level.
                          </small>
                        </article>
                        <article>
                          <strong>AI-generated explanation</strong>
                          <small>
                            {insightResult.provider} · {insightResult.model}
                          </small>
                          <p>{insightResult.summary}</p>
                        </article>
                        <article>
                          <strong>Recorded supporting events</strong>
                          {(insightResult.observedFacts ?? []).length === 0 ? (
                            <small>No cited recorded event details were returned.</small>
                          ) : (
                            (insightResult.observedFacts ?? []).map((fact) => (
                              <small key={fact.eventId}>
                                {fact.type.replaceAll('_', ' ')} ·{' '}
                                {new Date(fact.occurredAt).toLocaleString()} · Event {fact.eventId}
                                {fact.observationCount !== undefined
                                  ? ` · observations ${fact.observationCount}`
                                  : ''}
                                {fact.observationDurationMs !== undefined
                                  ? ` · duration ${fact.observationDurationMs} ms`
                                  : ''}
                                {fact.confidence !== undefined
                                  ? ` · detection confidence ${fact.confidence}`
                                  : ''}
                              </small>
                            ))
                          )}
                        </article>
                        <article>
                          <strong>AI interpretations and reviewer recommendations</strong>
                          {(insightResult.riskIndicators ?? []).map((indicator, index) => (
                            <small key={`${index}:${indicator.evidenceEventIds.join(',')}`}>
                              Risk indicator: {indicator.text} · Supporting event IDs:{' '}
                              {indicator.evidenceEventIds.join(', ')}
                            </small>
                          ))}
                          {(insightResult.reviewerRecommendations ?? []).map(
                            (recommendation, index) => (
                              <small key={`${index}:${recommendation}`}>
                                Reviewer recommendation: {recommendation}
                              </small>
                            )
                          )}
                        </article>
                        <article>
                          <strong>Confidence limitations</strong>
                          {(insightResult.confidenceLimitations ?? []).map((limitation) => (
                            <small key={limitation}>{limitation}</small>
                          ))}
                        </article>
                      </>
                    )}
                    {insightResult.observations?.map((observation, index) => (
                      <article key={`${index}:${observation.evidenceEventIds.join(',')}`}>
                        <strong>
                          {observation.kind === 'observed'
                            ? 'Recorded observation'
                            : 'Inference with uncertainty'}
                        </strong>
                        <p>{observation.text}</p>
                        <small>Evidence event IDs: {observation.evidenceEventIds.join(', ')}</small>
                        <small>Limitations: {observation.uncertainty}</small>
                      </article>
                    ))}
                  </div>
                )}
                <p className="admin-notice">
                  AI summaries use structured event metadata only. They are not misconduct findings,
                  and no confidence score or misconduct decision is produced; no webcam frames are
                  transmitted.
                </p>
                <EventRows events={filteredEvents} />
              </>
            )}
          </section>
        )
      case 'Reports':
        return (
          <section className="admin-card">
            <h2>Report data</h2>
            <p className="admin-notice">
              Exports contain only the selected real attempt or event records and their
              source/generated timestamp. Each export is recorded in the backend admin audit log.
            </p>
            <p>Generated from configured backend records at {formatTime(data.generatedAt)}.</p>
            <p>
              {data.assessments.length} assessments · {data.attempts.length} attempts ·{' '}
              {data.events.length} activity events
            </p>
            <div className="admin-export-actions">
              <button
                className="admin-primary-button"
                disabled={loading}
                onClick={() => void exportCsv('attempts')}
              >
                Export filtered attempts CSV
              </button>
              <button
                className="admin-secondary-button"
                disabled={loading || !data.activityLogAvailable}
                onClick={() => void exportCsv('events')}
              >
                Export filtered events CSV
              </button>
            </div>
            {!data.activityLogAvailable && (
              <p className="admin-empty">
                Event export is unavailable because activity event storage is not configured.
              </p>
            )}
          </section>
        )
      case 'Settings':
        return (
          <section className="admin-card">
            <h2>Console access</h2>
            <p>
              Administrator access requires a verified email OTP and an address in the backend
              PEARL_ADMIN_EMAILS allowlist.
            </p>
            <p>
              Management actions are disabled. This console does not create, edit, publish, or
              delete Airtable records.
            </p>
            <p>
              Instructor assignment and per-assessment authorization are not present in the current
              data model; access is administrator-only.
            </p>
          </section>
        )
    }
  }

  if (!authenticated) {
    return (
      <main className="admin-auth-shell">
        <section className="admin-auth-card">
          <div className="admin-brand">
            <span className="admin-brand-orb" /> PEARL <small>ADMIN CONSOLE</small>
          </div>
          <button className="admin-exit-button" onClick={onExit}>
            Back to browser
          </button>
          <h1>Administrator sign in</h1>
          <p>Verify using the email address configured in the backend administrator allowlist.</p>
          <form onSubmit={requestOtp}>
            <label htmlFor="admin-email">Administrator email</label>
            <input
              id="admin-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className="admin-primary-button" disabled={loading}>
              {loading ? 'Sending…' : 'Send verification code'}
            </button>
          </form>
          {otpRequested && (
            <form onSubmit={verifyOtp}>
              <label htmlFor="admin-otp">Six-digit code</label>
              <input
                id="admin-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button className="admin-primary-button" disabled={loading}>
                {loading ? 'Verifying…' : 'Verify and open console'}
              </button>
            </form>
          )}
          {notice && (
            <p className="admin-success" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          <p className="admin-footnote">
            Unauthorized addresses receive no code. Selecting this console does not grant
            administrator access.
          </p>
        </section>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="admin-auth-shell">
        <section className="admin-auth-card">
          <div className="admin-brand">
            <span className="admin-brand-orb" /> PEARL <small>ADMIN CONSOLE</small>
          </div>
          <button className="admin-exit-button" onClick={onExit}>
            Back to browser
          </button>
          <h1>Loading administrator dashboard</h1>
          {loading && <p role="status">Loading data from the configured backend…</p>}
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="admin-primary-button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? 'Loading…' : 'Retry dashboard load'}
          </button>
          <button className="admin-secondary-button" onClick={() => void logout()}>
            Sign out
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="admin-console">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="admin-brand-orb" /> PEARL <small>ADMIN CONSOLE</small>
        </div>
        <nav aria-label="Admin Console">
          {sections.map((item) => (
            <button
              key={item}
              className={section === item ? 'selected' : ''}
              onClick={() => setSection(item)}
            >
              <span aria-hidden="true">{sectionIcon(item)}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span>Authenticated administrator</span>
          <button onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <div>
            <span className="admin-eyebrow">PEARL BROWSER / ADMIN</span>
            <h1>{section}</h1>
          </div>
          <div className="admin-top-actions">
            <button
              className="admin-secondary-button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="admin-secondary-button" onClick={onExit}>
              Back to browser
            </button>
          </div>
        </header>
        {error && (
          <p className="admin-error admin-banner" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="admin-success admin-banner" role="status">
            {notice}
          </p>
        )}
        {section !== 'AI Question Generator' && (
          <div className="admin-filters">
            <input
              aria-label="Search current data"
              placeholder="Search candidates, attempts, or events"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Filter by assessment"
              value={assessmentFilter}
              onChange={(event) => setAssessmentFilter(event.target.value)}
            >
              <option value="all">All assessments</option>
              {data.assessments.map((assessment) => (
                <option key={assessment.id} value={assessment.id}>
                  {assessment.title || assessment.id}
                </option>
              ))}
            </select>
            {section === 'Assessments' && (
              <select
                aria-label="Filter publication status"
                value={publicationFilter}
                onChange={(event) => setPublicationFilter(event.target.value)}
              >
                <option value="all">All publication states</option>
                <option value="published">Published</option>
                <option value="unpublished">Unpublished</option>
              </select>
            )}
          </div>
        )}
        <div className="admin-content">
          {renderSection()}
          <p className="admin-data-footnote">
            Snapshot: {formatTime(data.generatedAt)} ·{' '}
            {data.activityLogAvailable ? 'Durable event log connected' : 'Activity log unavailable'}
          </p>
        </div>
      </section>
    </main>
  )
}

function sectionIcon(section: AdminSection): string {
  const icons: Record<AdminSection, string> = {
    Overview: '◫',
    Assessments: '▤',
    'AI Question Generator': '✦',
    Questions: '☷',
    Candidates: '◉',
    'Live Monitoring': '◷',
    'Attempts and Results': '✓',
    'Proctoring Events': '⌁',
    Reports: '▥',
    Settings: '⚙'
  }
  return icons[section]
}
