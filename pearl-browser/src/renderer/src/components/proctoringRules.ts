export type ProctoringReviewLevel = 'Low' | 'Medium' | 'High'

export interface ProctoringRuleEvent {
  id: string
  type: string
  occurredAt: string
  storageStatus: 'pending' | 'recorded' | 'failed'
  observationCount?: number
  observationDurationMs?: number
}

export interface ProctoringIndicator {
  id: string
  title: string
  detail: string
  events: ProctoringRuleEvent[]
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

export function deriveProctoringInsights(events: readonly ProctoringRuleEvent[]): {
  level: ProctoringReviewLevel
  indicators: ProctoringIndicator[]
} {
  const recorded = events
    .filter((event) => event.storageStatus === 'recorded')
    .slice()
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
  const indicators: ProctoringIndicator[] = []
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
