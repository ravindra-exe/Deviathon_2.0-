export type AssessmentStatus =
  | 'idle'
  | 'authenticating'
  | 'ready'
  | 'in_progress'
  | 'submitting'
  | 'submitted'
  | 'expired'
  | 'failed'

export interface AssessmentPolicy {
  allowedHosts: string[]
  blockedHosts?: string[]
  allowSubdomains: boolean
  localDevelopmentHosts: string[]
  allowHttpLocalDevelopment: boolean
  allowNewTabs: boolean
  allowPopupDestinations: boolean
  activeTabOnly: boolean
  allowLeavingAssessment: boolean
  durationMinutes: number
  recordHistory: boolean
  warningOnRestrictedAction: boolean
  cameraMonitoring?: boolean
  expirationBehavior: 'submit' | 'lock'
  cancellationBehavior: 'return-to-browser'
}

export interface AssessmentConfiguration {
  id: string
  provider?: 'local-demo' | 'remote-backend'
  title: string
  instructions: string
  questions: AssessmentQuestion[]
  questionCount?: number
  policy: AssessmentPolicy
}

export interface AssessmentParticipant {
  id: string
  displayName: string
  provider: string
  demoOnly: boolean
}

export interface AssessmentQuestion {
  id: string
  prompt: string
  options: Array<{ id: string; text: string }>
}

export interface AssessmentAnswer {
  questionId: string
  optionIndex: number
}

export interface AssessmentSubmission {
  id: string
  submittedAt: string
  status: 'accepted' | 'pending' | 'failed'
  message: string
}

export type AssessmentActivityEventType =
  | 'assessment_started'
  | 'assessment_submitted'
  | 'navigation_started'
  | 'navigation_completed'
  | 'search_performed'
  | 'ai_assistance_domain_visited'
  | 'tab_created'
  | 'tab_creation_blocked'
  | 'tab_closed'
  | 'tab_switched'
  | 'popup_blocked'
  | 'navigation_blocked'
  | 'redirect_observed'
  | 'camera_started'
  | 'camera_stopped'
  | 'camera_permission_denied'
  | 'camera_unavailable'
  | 'face_not_detected'
  | 'face_detected'
  | 'multiple_faces_detected'
  | 'camera_disconnected'

export interface AssessmentActivityEvent {
  type: AssessmentActivityEventType
  hostname?: string
  fromHostname?: string
  url?: string
  query?: string
  observationCount?: number
  observationDurationMs?: number
  confidence?: number
}

export interface AssessmentActivityReceipt {
  id: string
  occurredAt: string
}

export interface AssessmentActivityLogEntry extends AssessmentActivityEvent {
  id: string
  occurredAt: string
  source: 'assessment' | 'browser' | 'webcam'
  severity: 'info' | 'warning'
  storageStatus: 'pending' | 'recorded' | 'failed'
  storageError?: string
}

export interface ProctoringInsightObservation {
  kind: 'observed' | 'inference'
  text: string
  evidenceEventIds: string[]
  uncertainty: string
}

export interface ProctoringInsightResult {
  status: 'not_configured' | 'available' | 'failed'
  message: string
  observations?: ProctoringInsightObservation[]
}

export interface AssessmentEvent {
  id: string
  type:
    | 'authentication_started'
    | 'authenticated'
    | 'assessment_started'
    | 'answer_changed'
    | 'restricted_action'
    | 'submission_started'
    | 'submitted'
    | 'expired'
    | 'failed'
  timestamp: string
  detail: string
}

export interface AssessmentSession {
  status: AssessmentStatus
  configuration?: AssessmentConfiguration
  participant?: AssessmentParticipant
  answers: AssessmentAnswer[]
  currentQuestionIndex: number
  startedAt?: string
  deadline?: string
  attemptId?: string
  submission?: AssessmentSubmission
  events: AssessmentEvent[]
  activityEvents: AssessmentActivityLogEntry[]
  error?: string
}

export interface AssessmentAPI {
  getState(): Promise<AssessmentSession>
  start(mode: 'live' | 'demo'): Promise<AssessmentSession>
  authenticate(displayName: string, demoCode: string): Promise<AssessmentSession>
  requestOtp(email: string): Promise<AssessmentSession>
  begin(): Promise<AssessmentSession>
  answer(questionId: string, optionIndex: number): Promise<AssessmentSession>
  goToQuestion(index: number): Promise<AssessmentSession>
  submit(): Promise<AssessmentSession>
  cancel(): Promise<AssessmentSession>
  recordActivityEvent(event: AssessmentActivityEvent): Promise<void>
  setCameraConsent(consented: boolean): Promise<void>
  setCameraReadiness(ready: boolean): Promise<void>
  getProctoringInsights(): Promise<ProctoringInsightResult>
  onStateChange(listener: (state: AssessmentSession) => void): () => void
}
