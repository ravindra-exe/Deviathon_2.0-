import type {
  AssessmentActivityEvent,
  AssessmentConfiguration,
  AssessmentParticipant,
  AssessmentSubmission
} from '../../shared/assessment'
import type { AssessmentProvider } from './AssessmentProvider'

interface RemoteAssessmentProviderOptions {
  baseUrl: string
  assessmentId: string
  timeoutMs?: number
  useDevelopmentEnrollment?: boolean
}

interface RemoteAssessmentResponse {
  assessment: {
    id: string
    title: string
    instructions: string
    durationMinutes: number
    questions: Array<{
      id: string
      prompt: string
      options: Array<{ id: string; text: string }>
    }>
  }
}

interface AttemptResponse {
  attemptId: string
  status: string
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
  expirationBehavior: 'submit',
  cancellationBehavior: 'return-to-browser'
}

export class RemoteAssessmentProvider implements AssessmentProvider {
  private readonly baseUrl: string
  private readonly assessmentId: string
  private readonly timeoutMs: number
  private readonly useDevelopmentEnrollment: boolean
  private enrollmentToken?: string
  private sessionCredential?: string
  private configuration?: AssessmentConfiguration

  constructor(options: RemoteAssessmentProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.assessmentId = options.assessmentId
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.useDevelopmentEnrollment = options.useDevelopmentEnrollment === true
  }

  async getConfiguration(): Promise<AssessmentConfiguration> {
    if (!this.baseUrl || !this.assessmentId) {
      throw new Error('Remote assessment provider requires a backend URL and assessment ID.')
    }
    const response = await this.request<RemoteAssessmentResponse>(
      `/api/assessments/${encodeURIComponent(this.assessmentId)}`
    )
    const assessment = response.assessment
    const configuration: AssessmentConfiguration = {
      id: assessment.id,
      provider: 'remote-backend',
      title: assessment.title,
      instructions: `${assessment.instructions} Remote backend mode.`,
      questions: assessment.questions,
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
    await this.request('/api/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ email, assessmentId: this.assessmentId })
    })
  }

  async authenticateOtp(email: string, code: string): Promise<AssessmentParticipant> {
    const response = await this.request<{ sessionId: string; token: string }>(
      '/api/auth/otp/verify',
      {
        method: 'POST',
        body: JSON.stringify({ email, assessmentId: this.assessmentId, code })
      }
    )
    this.sessionCredential = `${response.sessionId}.${response.token}`
    return this.authenticate(email)
  }

  async startAttempt(
    configuration: AssessmentConfiguration,
    participant: AssessmentParticipant
  ): Promise<{ attemptId: string }> {
    const response = await this.request<AttemptResponse>(
      `/api/assessments/${encodeURIComponent(configuration.id)}/attempts`,
      {
        method: 'POST',
        body: JSON.stringify({ participantDisplayName: participant.displayName })
      }
    )
    return { attemptId: response.attemptId }
  }

  async submitAnswers(
    configuration: AssessmentConfiguration,
    answers: ReadonlyArray<{ questionId: string; optionIndex: number }>,
    attemptId?: string
  ): Promise<AssessmentSubmission> {
    if (!attemptId) throw new Error('Remote assessment attempt is unavailable.')
    const response = await this.request<SubmissionResponse>(
      `/api/attempts/${encodeURIComponent(attemptId)}/submissions`,
      {
        method: 'POST',
        body: JSON.stringify({
          assessmentId: configuration.id,
          answers: answers.map((answer) => ({
            questionId: answer.questionId,
            optionIndex: answer.optionIndex
          }))
        })
      }
    )
    return {
      id: response.submissionId,
      submittedAt: response.submittedAt,
      status: response.status,
      message: response.message
    }
  }

  async recordActivityEvent(event: AssessmentActivityEvent, attemptId: string): Promise<void> {
    await this.request(`/api/attempts/${encodeURIComponent(attemptId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ assessmentId: this.assessmentId, ...event })
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
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
