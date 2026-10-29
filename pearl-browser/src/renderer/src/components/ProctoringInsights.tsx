import { useMemo } from 'react'
import type {
  AssessmentActivityLogEntry,
  ProctoringInsightResult
} from '../../../shared/assessment'

type ReviewLevel = 'Low' | 'Medium' | 'High'

interface Indicator {
  id: string
  title: string
  detail: string
  events: AssessmentActivityLogEntry[]
}

interface ProctoringInsightsProps {
  events: AssessmentActivityLogEntry[]
  active: boolean
  summary?: ProctoringInsightResult
  summaryLoading: boolean
  onGenerateSummary: () => void
  onOpenTimeline: () => void
}

/** Replaceable boundary for a future server-side language-model summarizer. */
export interface ProctoringInsightProvider {
  summarize(events: readonly AssessmentActivityLogEntry[]): Promise<string>
}

const navigationPolicyEvents = new Set([
  'navigation_blocked',
  'popup_blocked',
  'tab_creation_blocked'
])
const cameraIssueEvents = new Set([
  'camera_stopped',
  'camera_permission_denied',
  'camera_unavailable',
  'camera_disconnected'
])

export function ProctoringInsights({
  events,
  active,
  summary,
  summaryLoading,
  onGenerateSummary,
  onOpenTimeline
}: ProctoringInsightsProps): React.JSX.Element {
  const insight = useMemo(() => deriveInsights(events), [events])
  return (
    <section className="proctoring-insights" aria-labelledby="proctoring-insights-title">
      <div className="proctoring-insights-heading">
        <div>
          <span className="proctoring-eyebrow">Evidence-based review</span>
          <h2 id="proctoring-insights-title">AI Proctoring Insights</h2>
        </div>
        <span className="proctoring-rules-label">Transparent rules</span>
      </div>
      <div className={`proctoring-risk risk-${insight.level.toLowerCase()}`} role="status">
        <span className="proctoring-risk-dot" />
        <span>Rule-based review level</span>
        <strong>{insight.level}</strong>
      </div>
      {insight.indicators.length === 0 ? (
        <p className="proctoring-insights-empty">
          {active
            ? 'No sustained review signals have been recorded for this attempt.'
            : 'Insights appear after the authenticated live attempt begins.'}
        </p>
      ) : (
        <ul className="proctoring-indicators">
          {insight.indicators.map((indicator) => (
            <li key={indicator.id}>
              <div>
                <strong>{indicator.title}</strong>
                <span>{indicator.detail}</span>
              </div>
              <div className="proctoring-evidence-list" aria-label="Supporting events">
                {indicator.events.slice(-3).map((event) => (
                  <span key={event.id} title={new Date(event.occurredAt).toLocaleString()}>
                    #{event.id.slice(-6)} · {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="proctoring-llm-actions">
        <div>
          <strong>Optional AI explanation</strong>
          <span>
            Uses structured recorded events only; no video frames or participant credentials are
            sent.
          </span>
        </div>
        <button
          className="toolbar-button"
          type="button"
          onClick={onGenerateSummary}
          disabled={!active || summaryLoading}
        >
          {summaryLoading ? 'Preparing summary…' : 'Generate AI summary'}
        </button>
      </div>
      {summary?.status === 'not_configured' && (
        <div className="proctoring-llm-state" role="status">
          {summary.message} Add both variables to the backend .env file and restart the backend.
        </div>
      )}
      {summary?.status === 'failed' && (
        <div className="proctoring-log-error" role="alert">
          <strong>AI summary unavailable</strong>
          <span>{summary.message}</span>
        </div>
      )}
      {summary?.status === 'available' && (
        <div className="proctoring-ai-summary" aria-live="polite">
          <div className="proctoring-ai-summary-heading">
            <strong>AI generated notes</strong>
            <span>{summary.message}</span>
          </div>
          {(summary.observations ?? []).length === 0 ? (
            <p>No summary observations were returned from the recorded timeline.</p>
          ) : (
            <ul>
              {summary.observations?.map((observation, index) => (
                <li key={`${observation.kind}-${index}`}>
                  <span className={`proctoring-ai-kind kind-${observation.kind}`}>
                    {observation.kind === 'observed' ? 'Observed' : 'Inference'}
                  </span>
                  <strong>{observation.text}</strong>
                  <span>{observation.uncertainty}</span>
                  <small>
                    Evidence:{' '}
                    {observation.evidenceEventIds.map((id) => `#${id.slice(-6)}`).join(', ')}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {(summary.observations ?? []).length > 0 && (
            <button className="text-button" type="button" onClick={onOpenTimeline}>
              Open supporting activity timeline
            </button>
          )}
        </div>
      )}
      <div className="proctoring-insights-footnote">
        <strong>Not a misconduct verdict.</strong> Signals describe recorded events only. Lighting,
        camera obstruction, device faults, and ordinary behavior can produce false positives. A
        reviewer must inspect the supporting timeline; a single event never disqualifies a
        participant. Rules: Medium follows one sustained face or camera signal or three blocked
        actions. High follows five blocked actions, three sustained face absences, two persistent
        multiple-face events, or two camera interruptions. Recognized AI-site visits remain
        informational and do not raise this level.
      </div>
      <div className="proctoring-llm-state" role="status">
        The displayed review level uses inspectable rules and verified backend-recorded events.
      </div>
    </section>
  )
}

function deriveInsights(events: AssessmentActivityLogEntry[]): {
  level: ReviewLevel
  indicators: Indicator[]
} {
  const recorded = events
    .filter((event) => event.storageStatus === 'recorded')
    .slice()
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
  const indicators: Indicator[] = []
  const sustainedAbsence = recorded.filter(
    (event) => event.type === 'face_not_detected' && (event.observationDurationMs ?? 0) >= 5_000
  )
  const persistentMultipleFaces = recorded.filter(
    (event) =>
      event.type === 'multiple_faces_detected' &&
      (event.observationDurationMs ?? 0) >= 2_000 &&
      (event.observationCount ?? 0) >= 3
  )
  const cameraIssues = recorded.filter((event) => cameraIssueEvents.has(event.type))
  const policyBlocks = recorded.filter((event) => navigationPolicyEvents.has(event.type))

  if (sustainedAbsence.length > 0) {
    indicators.push({
      id: 'face-absence',
      title: 'Sustained face absence observed',
      detail: `${sustainedAbsence.length} event${sustainedAbsence.length === 1 ? '' : 's'} after at least five seconds of consecutive local detections.`,
      events: sustainedAbsence
    })
  }
  if (persistentMultipleFaces.length > 0) {
    indicators.push({
      id: 'multiple-faces',
      title: 'Multiple faces persisted in the camera frame',
      detail: `${persistentMultipleFaces.length} event${persistentMultipleFaces.length === 1 ? '' : 's'} after at least two seconds and three observations.`,
      events: persistentMultipleFaces
    })
  }
  if (cameraIssues.length > 0) {
    indicators.push({
      id: 'camera-interruption',
      title: 'Camera monitoring interruption',
      detail: `${cameraIssues.length} camera stop, permission, availability, or disconnect event${cameraIssues.length === 1 ? '' : 's'} were recorded.`,
      events: cameraIssues
    })
  }
  if (policyBlocks.length > 0) {
    indicators.push({
      id: 'policy-blocks',
      title: 'Restricted browser actions were blocked',
      detail: `${policyBlocks.length} blocked navigation, popup, or tab creation attempt${policyBlocks.length === 1 ? '' : 's'} were recorded.`,
      events: policyBlocks
    })
  }

  const highRisk =
    policyBlocks.length >= 5 ||
    sustainedAbsence.length >= 3 ||
    persistentMultipleFaces.length >= 2 ||
    cameraIssues.length >= 2
  const mediumRisk =
    policyBlocks.length >= 3 ||
    sustainedAbsence.length > 0 ||
    persistentMultipleFaces.length > 0 ||
    cameraIssues.length > 0
  return {
    level: highRisk ? 'High' : mediumRisk ? 'Medium' : 'Low',
    indicators
  }
}
