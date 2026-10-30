import type {
  AdminAssessmentDraft,
  AdminAssessmentDraftSaved,
  AdminConsoleData,
  AdminQuestionGenerationRequest,
  AdminQuestionGenerationResult
} from '../../shared/admin'
import type { ProctoringInsightResult } from '../../shared/assessment'

interface AdminSessionResponse {
  sessionId: string
  token: string
  expiresAt: string
}

interface AdminSessionStatus {
  authenticated: boolean
  expiresAt: string
}

class AdminConsoleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class AdminConsoleClient {
  private readonly baseUrl: string
  private credential?: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async requestOtp(email: string): Promise<void> {
    await this.request(
      '/api/admin/auth/otp/request',
      { method: 'POST', body: JSON.stringify({ email }) },
      45_000
    )
  }

  async verifyOtp(email: string, code: string): Promise<void> {
    const response = await this.request<AdminSessionResponse>('/api/admin/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code })
    })
    if (
      typeof response.sessionId !== 'string' ||
      !response.sessionId ||
      typeof response.token !== 'string' ||
      !response.token ||
      !Number.isFinite(Date.parse(response.expiresAt)) ||
      Date.parse(response.expiresAt) <= Date.now()
    ) {
      throw new Error('The authentication server returned an invalid administrator session.')
    }
    this.credential = `${response.sessionId}.${response.token}`
  }

  async resume(): Promise<boolean> {
    if (!this.credential) return false
    try {
      const response = await this.request<AdminSessionStatus>('/api/admin/auth/session', {
        headers: { authorization: ['Bearer', this.credential].join(' ') }
      })
      return (
        response.authenticated === true &&
        Number.isFinite(Date.parse(response.expiresAt)) &&
        Date.parse(response.expiresAt) > Date.now()
      )
    } catch (error) {
      if (error instanceof AdminConsoleRequestError && error.status === 401) return false
      throw error
    }
  }

  async getData(): Promise<AdminConsoleData> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    return this.request<AdminConsoleData>('/api/admin/console', {
      headers: { Authorization: `Bearer ${this.credential}` }
    })
  }

  async generateQuestions(
    request: AdminQuestionGenerationRequest
  ): Promise<AdminQuestionGenerationResult> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    return this.request<AdminQuestionGenerationResult>(
      '/api/admin/question-generator/generate',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer '.concat(this.credential) },
        body: JSON.stringify(request)
      },
      120_000
    )
  }

  async saveAssessmentDraft(draft: AdminAssessmentDraft): Promise<AdminAssessmentDraftSaved> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    return this.request<AdminAssessmentDraftSaved>(
      '/api/admin/assessments/draft',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer '.concat(this.credential) },
        body: JSON.stringify(draft)
      },
      30_000
    )
  }

  async publishAssessment(
    assessmentId: string
  ): Promise<{ assessmentId: string; published: true }> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    return this.request<{ assessmentId: string; published: true }>(
      `/api/admin/assessments/${encodeURIComponent(assessmentId)}/publish`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer '.concat(this.credential) }
      },
      30_000
    )
  }

  async getInsights(attemptId: string, assessmentId: string): Promise<ProctoringInsightResult> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    return this.request<ProctoringInsightResult>(
      `/api/admin/attempts/${encodeURIComponent(attemptId)}/insights?assessmentId=${encodeURIComponent(assessmentId)}`,
      { headers: { Authorization: `Bearer ${this.credential}` } }
    )
  }

  async recordExport(targetId: 'attempts' | 'events'): Promise<void> {
    if (!this.credential) throw new Error('Administrator authentication is required.')
    await this.request('/api/admin/audit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.credential}` },
      body: JSON.stringify({ action: 'report_export', targetId })
    })
  }

  async logout(): Promise<void> {
    const credential = this.credential
    this.credential = undefined
    if (!credential) return
    await this.request('/api/admin/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}` }
    })
  }

  private async request<T = void>(
    path: string,
    init?: RequestInit,
    timeoutMs = 10_000
  ): Promise<T> {
    const baseUrl = this.validatedBaseUrl()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        },
        signal: controller.signal
      })
      const payload = (await response.json().catch(() => undefined)) as
        { error?: string } | T | undefined
      if (!response.ok) {
        const errorMessage =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'string'
            ? payload.error
            : `Administrator request failed (${response.status}).`
        if (response.status === 401) this.credential = undefined
        throw new AdminConsoleRequestError(
          response.status === 401
            ? 'Your administrator session has expired or is no longer valid. Sign in again.'
            : errorMessage,
          response.status
        )
      }
      return payload as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Administrator backend request timed out.', { cause: error })
      }
      if (error instanceof TypeError) {
        throw new Error(
          'Could not reach the administrator backend. Check that it is running and PEARL_ASSESSMENT_BACKEND_URL is correct.',
          { cause: error }
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private validatedBaseUrl(): string {
    let url: URL
    try {
      url = new URL(this.baseUrl)
    } catch {
      throw new Error('Configure PEARL_ASSESSMENT_BACKEND_URL before using the Admin Console.')
    }
    const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost))
    ) {
      throw new Error('The administrator backend URL must use HTTPS or a local development host.')
    }
    return url.origin
  }
}
