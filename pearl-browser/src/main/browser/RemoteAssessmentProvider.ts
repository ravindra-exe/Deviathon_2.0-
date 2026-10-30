import type {
  AssessmentActivityEvent,
  AssessmentActivityReceipt,
  AssessmentConfiguration,
  AssessmentParticipant,
  AssessmentQuestion,
  AssessmentSubmission,
  AutomaticSubmissionTrigger,
  ProctoringInsightResult
} from '../../shared/assessment'
import type { AssessmentProvider } from './AssessmentProvider'

interface RemoteAssessmentProviderOptions {
  baseUrl: string
  assessmentId: string
  timeoutMs?: number
  otpRequestTimeoutMs?: number
  useDevelopmentEnrollment?: boolean
}

interface RemoteAssessmentResponse {
  assessment: {
    id: string
    title: string
    instructions: string
    durationMinutes: number
    questionCount: number
  }
}

interface AttemptResponse {
  attemptId: string
  status: string
  startedAt: string
  deadline: string
}

interface QuestionsResponse {
  questions: AssessmentQuestion[]
}

interface EnrollmentTokenResponse {
  token: string
  expiresAt: string
}

interface SubmissionResponse {
  submissionId: string
  status: 'accepted' | 'pending'
  submittedAt: string
  message: string
}

const remotePolicy: AssessmentConfiguration['policy'] = {
  allowedHosts: [],
  blockedHosts: [],
  allowSubdomains: false,
  localDevelopmentHosts: ['127.0.0.1', 'localhost'],
  allowHttpLocalDevelopment: true,
  allowNewTabs: false,
  allowPopupDestinations: false,
  activeTabOnly: true,
  allowLeavingAssessment: false,
  durationMinutes: 10,
  recordHistory: false,
  warningOnRestrictedAction: true,
  cameraMonitoring: true,
  expirationBehavior: 'submit',
  cancellationBehavior: 'return-to-browser'
}

export class RemoteAssessmentProvider implements AssessmentProvider {
  private readonly baseUrl: string
  private readonly assessmentId: string
  private readonly timeoutMs: number
  private readonly otpRequestTimeoutMs: number
  private readonly useDevelopmentEnrollment: boolean
  private enrollmentToken?: string
  private sessionCredential?: string
  private authenticatedEmail?: string
  private configuration?: AssessmentConfiguration

  constructor(options: RemoteAssessmentProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.assessmentId = options.assessmentId
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.otpRequestTimeoutMs = options.otpRequestTimeoutMs ?? 45_000
    this.useDevelopmentEnrollment = options.useDevelopmentEnrollment === true
  }

  async getConfiguration(): Promise<AssessmentConfiguration> {
    if (!this.baseUrl || !this.assessmentId) {
      throw new Error('Remote assessment provider requires a backend URL and assessment ID.')
    }
    let response: RemoteAssessmentResponse
    try {
      response = await this.request<RemoteAssessmentResponse>(
        `/api/assessments/${encodeURIComponent(this.assessmentId)}`
      )
    } catch (error) {
      throw operationError('load published assessment metadata', error, this.baseUrl)
    }
    const assessment = response.assessment
    const configuration: AssessmentConfiguration = {
      id: assessment.id,
      provider: 'remote-backend',
      title: assessment.title,
      instructions: assessment.instructions,
      questions: [],
      questionCount: assessment.questionCount,
      policy: { ...remotePolicy, durationMinutes: assessment.durationMinutes }
    }
    this.configuration = configuration
    if (this.useDevelopmentEnrollment) {
      const enrollment = await this.request<EnrollmentTokenResponse>('/api/dev/enrollment-tokens', {
        method: 'POST',
        body: JSON.stringify({ assessmentId: assessment.id })
      })
      this.enrollmentToken = enrollment.token
    }
    return configuration
  }

  async loadQuestions(configuration: AssessmentConfiguration): Promise<AssessmentQuestion[]> {
    if (!this.sessionCredential)
      throw new Error('Verify your email before loading assessment questions.')
    let response: QuestionsResponse
    try {
      response = await this.request<QuestionsResponse>(
        `/api/assessments/${encodeURIComponent(configuration.id)}/questions`
      )
    } catch (error) {
      throw operationError('load assessment questions', error, this.baseUrl)
    }
    return response.questions
  }

  async authenticate(displayName: string): Promise<AssessmentParticipant> {
    if (!this.configuration) throw new Error('Load the remote assessment before authenticating.')
    const name = displayName.trim().toLowerCase()
    if (!name) throw new Error('Enter a participant display name.')
    if (!this.sessionCredential) throw new Error('Request an email verification code first.')
    return {
      id: `remote-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40)}`,
      displayName: name,
      provider: 'remote-backend',
      demoOnly: false
    }
  }

  async requestOtp(email: string): Promise<void> {
    try {
      await this.request(
        '/api/auth/otp/request',
        {
          method: 'POST',
          body: JSON.stringify({ email, assessmentId: this.assessmentId })
        },
        this.otpRequestTimeoutMs
      )
    } catch (error) {
      throw operationError('send OTP email', error, this.baseUrl)
    }
  }

  async authenticateOtp(email: string, code: string): Promise<AssessmentParticipant> {
    const normalizedEmail = email.trim().toLowerCase()
    if (this.sessionCredential && this.authenticatedEmail === normalizedEmail) {
      return this.authenticate(normalizedEmail)
    }
    if (this.sessionCredential) await this.logout()
    let response: {
      sessionId: string
      token: string
      assessmentId: string
      expiresAt: string
    }
    try {
      response = await this.request<{
        sessionId: string
        token: string
        assessmentId: string
        expiresAt: string
      }>('/api/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail, assessmentId: this.assessmentId, code })
      })
    } catch (error) {
      throw operationError('verify OTP', error, this.baseUrl)
    }
    if (
      typeof response.sessionId !== 'string' ||
      !response.sessionId ||
      typeof response.token !== 'string' ||
      !response.token ||
      response.assessmentId !== this.assessmentId ||
      !Number.isFinite(Date.parse(response.expiresAt)) ||
      Date.parse(response.expiresAt) <= Date.now()
    ) {
      throw new Error('The authentication server returned an invalid session.')
    }
    this.sessionCredential = `${response.sessionId}.${response.token}`
    this.authenticatedEmail = normalizedEmail
    return this.authenticate(normalizedEmail)
  }

  async logout(): Promise<void> {
    const credential = this.sessionCredential
    this.sessionCredential = undefined
    this.authenticatedEmail = undefined
    this.enrollmentToken = undefined
    if (!credential) return
    await this.request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}` }
    })
  }

  async startAttempt(
    configuration: AssessmentConfiguration,
    participant: AssessmentParticipant
  ): Promise<{ attemptId: string; startedAt: string; deadline: string }> {
    let response: AttemptResponse
    try {
      response = await this.request<AttemptResponse>(
        `/api/assessments/${encodeURIComponent(configuration.id)}/attempts`,
        {
          method: 'POST',
          body: JSON.stringify({ participantDisplayName: participant.displayName })
        }
      )
    } catch (error) {
      throw operationError('create authenticated assessment attempt', error, this.baseUrl)
    }
    if (
      typeof response.attemptId !== 'string' ||
      !response.attemptId ||
      !Number.isFinite(Date.parse(response.startedAt)) ||
      !Number.isFinite(Date.parse(response.deadline))
    ) {
      throw new Error('The backend returned an incomplete authenticated attempt.')
    }
    return {
      attemptId: response.attemptId,
      startedAt: response.startedAt,
      deadline: response.deadline
    }
  }

  async submitAnswers(
    configuration: AssessmentConfiguration,
    answers: ReadonlyArray<{ questionId: string; optionIndex: number }>,
    attemptId?: string,
    trigger?: AutomaticSubmissionTrigger
  ): Promise<AssessmentSubmission> {
    if (!attemptId) throw new Error('Remote assessment attempt is unavailable.')
    let response: SubmissionResponse
    try {
      response = await this.request<SubmissionResponse>(
        `/api/attempts/${encodeURIComponent(attemptId)}/submissions`,
        {
          method: 'POST',
          body: JSON.stringify({
            assessmentId: configuration.id,
            answers: answers.map((answer) => ({
              questionId: answer.questionId,
              optionIndex: answer.optionIndex
            })),
            ...(trigger === 'deadline' ? { trigger } : {})
          })
        }
      )
    } catch (error) {
      throw operationError('submit assessment answers', error, this.baseUrl)
    }
    if (response.status !== 'accepted') {
      throw new Error(
        response.message || 'The assessment server has not confirmed the submission yet.'
      )
    }
    if (
      !response.submissionId ||
      !Number.isFinite(Date.parse(response.submittedAt)) ||
      typeof response.message !== 'string'
    ) {
      throw new Error('The assessment server returned an incomplete submission confirmation.')
    }
    return {
      id: response.submissionId,
      submittedAt: response.submittedAt,
      status: response.status,
      message: response.message
    }
  }

  async recordActivityEvent(
    event: AssessmentActivityEvent,
    attemptId: string
  ): Promise<AssessmentActivityReceipt> {
    const response = await this.request<{
      accepted: boolean
      event: AssessmentActivityReceipt
    }>(`/api/attempts/${encodeURIComponent(attemptId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ assessmentId: this.assessmentId, ...event })
    })
    if (
      response.accepted !== true ||
      typeof response.event?.id !== 'string' ||
      !response.event.id ||
      !Number.isFinite(Date.parse(response.event.occurredAt))
    ) {
      throw new Error('The backend did not confirm the activity log entry.')
    }
    return response.event
  }

  async getProctoringInsights(
    attemptId: string,
    assessmentId: string
  ): Promise<ProctoringInsightResult> {
    if (!this.sessionCredential) throw new Error('Verify your email before requesting insights.')
    return this.request<ProctoringInsightResult>(
      `/api/attempts/${encodeURIComponent(attemptId)}/proctoring-insights?assessmentId=${encodeURIComponent(assessmentId)}`
    )
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(this.enrollmentToken ? { Authorization: `Bearer ${this.enrollmentToken}` } : {}),
          ...(init?.headers ?? {}),
          ...(this.sessionCredential ? { Authorization: `Bearer ${this.sessionCredential}` } : {})
        },
        signal: controller.signal
      })
      const payload = (await response.json().catch(() => undefined)) as
        { error?: string } | undefined
      if (!response.ok) {
        throw new Error(payload?.error || `Remote assessment request failed (${response.status}).`)
      }
      return payload as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Remote assessment backend timed out.', { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function operationError(operation: string, error: unknown, baseUrl: string): Error {
  const detail = error instanceof Error ? error.message : 'The backend request failed.'
  if (error instanceof TypeError && detail.toLowerCase().includes('fetch failed')) {
    let destination = 'the configured assessment backend'
    try {
      destination = new URL(baseUrl).origin
    } catch {
      return new Error(
        `Failed to ${operation}: Could not connect to ${destination}. Check the backend URL and start it with "npm run backend:dev".`,
        { cause: error }
      )
    }
    return new Error(
      `Failed to ${operation}: Could not connect to ${destination}. Check that the backend is running and that PEARL_ASSESSMENT_BACKEND_URL matches its address.`,
      { cause: error }
    )
  }
  return new Error(`Failed to ${operation}: ${detail}`, { cause: error })
}
