import type {
  AssessmentActivityEvent,
  AssessmentConfiguration,
  AssessmentEvent,
  AssessmentSession
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
  events: []
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
    this.addEvent('authentication_started', 'Local demonstration authentication started.')
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
      const attempt = this.provider.startAttempt
        ? await this.provider.startAttempt(this.session.configuration!, participant)
        : { attemptId: `local-attempt-${Date.now()}` }
      this.session = { ...this.session, participant, attemptId: attempt.attemptId }
      this.addEvent('authenticated', `Demo participant ${participant.displayName} authenticated.`)
      return this.getState()
    } catch (error) {
      return this.fail(error)
    }
  }

  async requestOtp(email: string): Promise<AssessmentSession> {
    this.requireStatus('ready')
    if (!this.provider.requestOtp) throw new Error('Email authentication is unavailable.')
    try {
      await this.provider.requestOtp(email, this.session.configuration!.id)
      return this.getState()
    } catch (error) {
      return this.fail(error)
    }
  }

  async begin(): Promise<AssessmentSession> {
    this.requireStatus('ready')
    if (!this.session.participant) throw new Error('Authenticate before beginning the assessment.')
    this.sessionGeneration += 1
    const startedAt = new Date(this.clock.now())
    const deadline = new Date(
      startedAt.getTime() + this.session.configuration!.policy.durationMinutes * 60_000
    )
    this.session = {
      ...this.session,
      status: 'in_progress',
      startedAt: startedAt.toISOString(),
      deadline: deadline.toISOString()
    }
    this.addEvent('assessment_started', `Assessment started; deadline ${deadline.toISOString()}.`)
    this.scheduleExpiration()
    return this.getState()
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
    this.session = { ...this.session, answers }
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
      this.clearTimer()
      return this.getState()
    } catch (error) {
      return this.fail(error)
    }
  }

  async recordActivityEvent(event: AssessmentActivityEvent): Promise<void> {
    if (this.session.status !== 'in_progress' || !this.session.attemptId) return
    if (!this.provider.recordActivityEvent) return
    try {
      await this.provider.recordActivityEvent(event, this.session.attemptId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Audit event storage failed.'
      console.warn(`Assessment audit event was not saved: ${message.slice(0, 160)}`)
    }
  }

  cancel(): AssessmentSession {
    this.clearTimer()
    this.sessionGeneration += 1
    this.session = EMPTY_SESSION()
    this.publish()
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

function validateConfiguration(configuration: AssessmentConfiguration): void {
  if (!configuration.id || !configuration.title || configuration.questions.length === 0) {
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
