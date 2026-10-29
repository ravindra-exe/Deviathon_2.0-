import type {
  AssessmentActivityEvent,
  AssessmentActivityLogEntry,
  AssessmentConfiguration,
  AssessmentEvent,
  AssessmentSession,
  ProctoringInsightResult
} from '../../shared/assessment'
import type { AssessmentProvider } from './AssessmentProvider'
import {
  evaluateAssessmentNavigation,
  validateAssessmentPolicy
} from './AssessmentNavigationPolicy'

export interface AssessmentClock {
  now(): number
  setTimeout(callback: () => void, delay: number): NodeJS.Timeout
  clearTimeout(timer: NodeJS.Timeout): void
}

const systemClock: AssessmentClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer)
}

const EMPTY_SESSION = (): AssessmentSession => ({
  status: 'idle',
  answers: [],
  currentQuestionIndex: 0,
  events: [],
  activityEvents: []
})

export class AssessmentManager {
  private session = EMPTY_SESSION()
  private expirationTimer: NodeJS.Timeout | undefined
  private sessionGeneration = 0

  constructor(
    private readonly provider: AssessmentProvider,
    private readonly onChange: (session: AssessmentSession) => void,
    private readonly clock: AssessmentClock = systemClock
  ) {}

  getState(): AssessmentSession {
    return structuredClone(this.session)
  }

  async start(): Promise<AssessmentSession> {
    this.requireStatus('idle', 'failed', 'submitted', 'expired')
    this.clearTimer()
    this.sessionGeneration += 1
    this.session = { ...EMPTY_SESSION(), status: 'authenticating' }
    this.addEvent('authentication_started', 'Assessment configuration loading started.')
    try {
      const configuration = await this.provider.getConfiguration()
      validateConfiguration(configuration)
      this.session = { ...this.session, configuration, status: 'ready' }
      this.publish()
      return this.getState()
    } catch (error) {
      return this.fail(error)
    }
  }

  async authenticate(displayName: string, demoCode: string): Promise<AssessmentSession> {
    this.requireStatus('ready')
    try {
      const participant = this.provider.authenticateOtp
        ? await this.provider.authenticateOtp(displayName, demoCode)
        : await this.provider.authenticate(displayName, demoCode)
      this.session = { ...this.session, participant, error: undefined }
      this.addEvent('authenticated', 'Participant authenticated.')
      return this.getState()
    } catch (error) {
      if (this.session.status !== 'ready') return this.fail(error)
      throw error
    }
  }

  async requestOtp(email: string): Promise<AssessmentSession> {
    this.requireStatus('ready')
    if (!this.provider.requestOtp) throw new Error('Email authentication is unavailable.')
    await this.provider.requestOtp(email, this.session.configuration!.id)
    return this.getState()
  }

  async begin(): Promise<AssessmentSession> {
    this.requireStatus('ready')
    if (!this.session.participant) throw new Error('Authenticate before beginning the assessment.')
    const participant = this.session.participant
    this.session = { ...this.session, status: 'authenticating', error: undefined }
    this.publish()
    try {
      if (!this.session.attemptId) {
        const attempt = this.provider.startAttempt
          ? await this.provider.startAttempt(this.session.configuration!, participant)
          : { attemptId: `local-attempt-${Date.now()}` }
        this.session = {
          ...this.session,
          attemptId: attempt.attemptId,
          startedAt: attempt.startedAt,
          deadline: attempt.deadline
        }
        this.publish()
      }
      if (this.provider.loadQuestions) {
        const questions = await this.provider.loadQuestions(this.session.configuration!)
        if (!questions.length) throw new Error('The published assessment has no active questions.')
        const expectedCount = this.session.configuration!.questionCount
        if (expectedCount !== undefined && questions.length !== expectedCount) {
          throw new Error(
            `The backend returned ${questions.length} questions; the assessment metadata reports ${expectedCount}.`
          )
        }
        this.session = {
          ...this.session,
          configuration: {
            ...this.session.configuration!,
            questions,
            questionCount: questions.length
          },
          status: 'ready'
        }
      }
      const startedAt = this.session.startedAt
        ? new Date(this.session.startedAt)
        : new Date(this.clock.now())
      const deadline = this.session.deadline
        ? new Date(this.session.deadline)
        : new Date(
            startedAt.getTime() + this.session.configuration!.policy.durationMinutes * 60_000
          )
      if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(deadline.getTime())) {
        throw new Error('The backend returned an invalid attempt deadline.')
      }
      this.session = {
        ...this.session,
        status: 'in_progress',
        startedAt: startedAt.toISOString(),
        deadline: deadline.toISOString(),
        error: undefined
      }
      this.sessionGeneration += 1
      this.addEvent('assessment_started', `Assessment started; deadline ${deadline.toISOString()}.`)
      void this.recordActivityEvent({ type: 'assessment_started' })
      this.scheduleExpiration()
      return this.getState()
    } catch (error) {
      this.session = {
        ...this.session,
        status: 'ready',
        error: error instanceof Error ? error.message : 'Assessment could not be started.'
      }
      this.addEvent('failed', this.session.error ?? 'Assessment could not be started.')
      return this.getState()
    }
  }

  answer(questionId: string, optionIndex: number): AssessmentSession {
    this.requireStatus('in_progress')
    this.ensureNotExpired()
    const question = this.session.configuration!.questions.find((item) => item.id === questionId)
    if (
      !question ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= question.options.length
    ) {
      throw new Error('Invalid assessment answer.')
    }
    const answers = this.session.answers.filter((answer) => answer.questionId !== questionId)
    answers.push({ questionId, optionIndex })
    this.session = { ...this.session, answers, error: undefined }
    this.addEvent('answer_changed', `Answer recorded for ${questionId}.`)
    return this.getState()
  }

  goToQuestion(index: number): AssessmentSession {
    this.requireStatus('in_progress')
    this.ensureNotExpired()
    const count = this.session.configuration!.questions.length
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new Error('Invalid question index.')
    this.session = { ...this.session, currentQuestionIndex: index }
    this.publish()
    return this.getState()
  }

  async submit(): Promise<AssessmentSession> {
    if (this.session.status === 'submitted') return this.getState()
    this.requireStatus('in_progress', 'expired')
    if (this.session.status === 'in_progress') this.ensureNotExpired()
    const previousStatus = this.session.status
    this.session = { ...this.session, status: 'submitting' }
    this.addEvent('submission_started', 'Assessment submission started.')
    try {
      const submission = await this.provider.submitAnswers(
        this.session.configuration!,
        this.session.answers,
        this.session.attemptId
      )
      this.session = { ...this.session, status: 'submitted', submission }
      this.addEvent('submitted', submission.message)
      void this.recordActivityEvent({ type: 'assessment_submitted' })
      this.clearTimer()
      return this.getState()
    } catch (error) {
      this.session = {
        ...this.session,
        status: previousStatus,
        error: error instanceof Error ? error.message : 'Assessment submission failed.'
      }
      this.addEvent('failed', this.session.error ?? 'Assessment submission failed.')
      return this.getState()
    }
  }

  async recordActivityEvent(event: AssessmentActivityEvent): Promise<void> {
    const isConfirmedSubmission =
      event.type === 'assessment_submitted' && this.session.status === 'submitted'
    if (
      (this.session.status !== 'in_progress' && !isConfirmedSubmission) ||
      !this.session.attemptId ||
      this.session.configuration?.provider !== 'remote-backend'
    ) {
      return
    }
    const attemptId = this.session.attemptId
    if (!attemptId) return
    const safeEvent = sanitizeActivityEvent(event)
    const id = crypto.randomUUID()
    const entry: AssessmentActivityLogEntry = {
      ...safeEvent,
      id,
      occurredAt: new Date().toISOString(),
      source:
        safeEvent.type === 'assessment_started' || safeEvent.type === 'assessment_submitted'
          ? 'assessment'
          : safeEvent.type.startsWith('camera_') || safeEvent.type.startsWith('face_')
            ? 'webcam'
            : 'browser',
      severity:
        safeEvent.type === 'navigation_blocked' ||
        safeEvent.type === 'popup_blocked' ||
        safeEvent.type === 'tab_creation_blocked' ||
        safeEvent.type === 'face_not_detected' ||
        safeEvent.type === 'multiple_faces_detected' ||
        safeEvent.type === 'camera_stopped' ||
        safeEvent.type === 'camera_permission_denied' ||
        safeEvent.type === 'camera_unavailable' ||
        safeEvent.type === 'camera_disconnected'
          ? 'warning'
          : 'info',
      storageStatus: 'pending'
    }
    this.session = {
      ...this.session,
      activityEvents: [...this.session.activityEvents, entry]
    }
    this.publish()

    try {
      if (!this.provider.recordActivityEvent) {
        throw new Error('Activity logging is unavailable for this live attempt.')
      }
      const receipt = await this.provider.recordActivityEvent(safeEvent, attemptId)
      this.updateActivityEntry(id, (current) => ({
        ...current,
        id: receipt.id,
        occurredAt: receipt.occurredAt,
        storageStatus: 'recorded',
        storageError: undefined
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Audit event storage failed.'
      const storageError = message.slice(0, 180)
      this.updateActivityEntry(id, (current) => ({
        ...current,
        storageStatus: 'failed',
        storageError
      }))
      console.warn(`Assessment audit event was not recorded: ${storageError}`)
    }
  }

  async getProctoringInsights(): Promise<ProctoringInsightResult> {
    if (
      !this.session.attemptId ||
      !this.session.configuration ||
      this.session.configuration.provider !== 'remote-backend'
    ) {
      return {
        status: 'not_configured',
        message: 'AI summaries are available only for an authenticated live assessment attempt.'
      }
    }
    if (!this.provider.getProctoringInsights) {
      return {
        status: 'not_configured',
        message: 'The live assessment backend does not provide AI summaries.'
      }
    }
    return this.provider.getProctoringInsights(
      this.session.attemptId,
      this.session.configuration.id
    )
  }

  private updateActivityEntry(
    id: string,
    update: (entry: AssessmentActivityLogEntry) => AssessmentActivityLogEntry
  ): void {
    if (!this.session.activityEvents.some((entry) => entry.id === id)) return
    const activityEvents = this.session.activityEvents.map((entry) =>
      entry.id === id ? update(entry) : entry
    )
    this.session = { ...this.session, activityEvents }
    this.publish()
  }

  async cancel(): Promise<AssessmentSession> {
    this.clearTimer()
    this.sessionGeneration += 1
    this.session = EMPTY_SESSION()
    this.publish()
    try {
      await this.provider.logout?.()
    } catch {
      // The local credential is cleared by the provider even if the server is unavailable.
    }
    return this.getState()
  }

  canNavigate(url: string, options: { popup?: boolean; newTab?: boolean } = {}): boolean {
    return this.evaluateNavigation(url, options).allowed
  }

  canCreateTab(): boolean {
    const policy = this.session.configuration?.policy
    const active =
      this.session.status === 'in_progress' ||
      this.session.status === 'submitting' ||
      this.session.status === 'expired'
    return !active || !policy || policy.allowNewTabs
  }

  evaluateNavigation(
    url: string,
    options: { popup?: boolean; newTab?: boolean } = {}
  ): { allowed: boolean; reason: string } {
    const active =
      this.session.status === 'in_progress' ||
      this.session.status === 'submitting' ||
      this.session.status === 'expired'
    if (!active) {
      return { allowed: true, reason: 'assessment-inactive' }
    }
    const policy = this.session.configuration?.policy
    if (!policy) return { allowed: true, reason: 'assessment-inactive' }
    if (policy.allowLeavingAssessment) {
      if (options.newTab && !policy.allowNewTabs) {
        this.addEvent('restricted_action', 'Blocked navigation (new-tab-not-allowed).')
        return { allowed: false, reason: 'new-tab-not-allowed' }
      }
      if (options.popup && !policy.allowPopupDestinations) {
        this.addEvent('restricted_action', 'Blocked navigation (popup-not-allowed).')
        return { allowed: false, reason: 'popup-not-allowed' }
      }
      return { allowed: true, reason: 'assessment-inactive' }
    }
    const decision = evaluateAssessmentNavigation(url, policy, options)
    if (!decision.allowed) {
      this.addEvent('restricted_action', `Blocked navigation (${decision.reason}).`)
    }
    return decision
  }

  private ensureNotExpired(): void {
    if (this.session.deadline && this.clock.now() >= Date.parse(this.session.deadline)) {
      this.expire()
      throw new Error('Assessment time has expired.')
    }
  }

  private expire(): void {
    if (this.session.status !== 'in_progress') return
    this.session = { ...this.session, status: 'expired' }
    this.addEvent('expired', 'Assessment deadline reached.')
  }

  private scheduleExpiration(): void {
    this.clearTimer()
    const generation = this.sessionGeneration
    const delay = Math.max(0, Date.parse(this.session.deadline!) - this.clock.now())
    this.expirationTimer = this.clock.setTimeout(() => {
      if (generation !== this.sessionGeneration || this.session.status !== 'in_progress') return
      this.expire()
      if (this.session.configuration?.policy.expirationBehavior === 'submit') void this.submit()
    }, delay)
  }

  private clearTimer(): void {
    if (this.expirationTimer) this.clock.clearTimeout(this.expirationTimer)
    this.expirationTimer = undefined
  }

  private requireStatus(...statuses: AssessmentSession['status'][]): void {
    if (!statuses.includes(this.session.status)) {
      throw new Error(`Assessment action is not valid while ${this.session.status}.`)
    }
  }

  private addEvent(type: AssessmentEvent['type'], detail: string): void {
    this.session.events = [
      ...this.session.events,
      {
        id: `assessment-event-${Date.now()}-${this.session.events.length}`,
        type,
        detail,
        timestamp: new Date().toISOString()
      }
    ].slice(-100)
    this.publish()
  }

  private publish(): void {
    this.onChange(this.getState())
  }

  private fail(error: unknown): AssessmentSession {
    this.clearTimer()
    this.session = {
      ...this.session,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Assessment operation failed.'
    }
    this.addEvent('failed', this.session.error ?? 'Assessment operation failed.')
    return this.getState()
  }
}

function sanitizeActivityEvent(event: AssessmentActivityEvent): AssessmentActivityEvent {
  const safe: AssessmentActivityEvent = { type: event.type }
  for (const key of ['hostname', 'fromHostname'] as const) {
    const value = event[key]
    if (typeof value !== 'string') continue
    const hostname = normalizeHostname(value)
    if (hostname) safe[key] = hostname
  }
  if (typeof event.url === 'string') {
    try {
      const url = new URL(event.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') safe.url = url.origin
    } catch {
      // Invalid URLs are omitted so an event can never expose raw input.
    }
  }
  if (
    Number.isInteger(event.observationCount) &&
    event.observationCount! >= 1 &&
    event.observationCount! <= 100
  ) {
    safe.observationCount = event.observationCount
  }
  if (
    Number.isInteger(event.observationDurationMs) &&
    event.observationDurationMs! >= 0 &&
    event.observationDurationMs! <= 600_000
  ) {
    safe.observationDurationMs = event.observationDurationMs
  }
  if (
    typeof event.confidence === 'number' &&
    Number.isFinite(event.confidence) &&
    event.confidence >= 0 &&
    event.confidence <= 1
  ) {
    safe.confidence = event.confidence
  }
  // Search terms are deliberately excluded; the event itself records that a
  // browser address-bar search occurred without retaining the typed text.
  return safe
}

function normalizeHostname(value: string): string | undefined {
  try {
    return new URL(`https://${value}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function validateConfiguration(configuration: AssessmentConfiguration): void {
  if (!configuration.id || !configuration.title) {
    throw new Error('Assessment configuration is incomplete.')
  }
  if (
    configuration.questions.length === 0 &&
    (configuration.provider !== 'remote-backend' ||
      !Number.isInteger(configuration.questionCount) ||
      configuration.questionCount! < 1)
  ) {
    throw new Error('Assessment configuration is incomplete.')
  }
  if (
    !Number.isFinite(configuration.policy.durationMinutes) ||
    configuration.policy.durationMinutes <= 0 ||
    configuration.policy.durationMinutes > 24 * 60
  ) {
    throw new Error('Assessment duration is invalid.')
  }
  validateAssessmentPolicy(configuration.policy)
  for (const question of configuration.questions) {
    if (!question.id || !question.prompt || question.options.length < 2) {
      throw new Error('Assessment question configuration is invalid.')
    }
  }
}
