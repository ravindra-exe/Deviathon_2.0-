import type { ProctoringInsightResult } from './assessment'

export interface AdminConsoleEvent {
  id: string
  assessmentId: string
  attemptId: string
  type: string
  occurredAt: string
  hostname?: string
  fromHostname?: string
  observationCount?: number
  observationDurationMs?: number
  confidence?: number
}

export interface AdminConsoleAssessment {
  id: string
  title: string
  durationMinutes: number | null
  isPublished: boolean
  questionCount: number
  attemptCount: number
}

export interface AdminConsoleQuestion {
  recordId: string
  id: string
  assessmentId: string
  prompt: string
  order: number | null
  isActive: boolean
  options: Array<{ id: string; text: string }>
  validationError?: string
}

export interface AdminConsoleQuestionValidationError {
  recordId: string
  questionId: string
  assessmentId: string
  message: string
}

export interface AdminConsoleAttempt {
  id: string
  assessmentId: string
  participantDisplayName: string
  participantEmail: string
  status: string
  startedAt: string
  deadline: string
  answeredQuestionCount: number | null
  totalQuestionCount: number
  cameraStatus: string
  submittedAt: string
  submissionId: string
  latestActivity?: AdminConsoleEvent
}

export interface AdminConsoleData {
  generatedAt: string
  metrics: {
    totalAssessments: number
    publishedAssessments: number
    totalCandidates: number
    activeAttempts: number
    submittedAttempts: number
    expiredAttempts: number
    failedAttempts: number
  }
  assessments: AdminConsoleAssessment[]
  questions: AdminConsoleQuestion[]
  questionValidationErrors: AdminConsoleQuestionValidationError[]
  attempts: AdminConsoleAttempt[]
  events: AdminConsoleEvent[]
  activityLogAvailable: boolean
}

export interface AdminQuestionDraft {
  id: string
  prompt: string
  options: Array<{ id: string; text: string }>
  correctOptionId: string
  explanation: string
  difficulty: 'Easy' | 'Medium' | 'Hard'
  topic: string
  order: number
}

export interface AdminQuestionGenerationRequest {
  subject: string
  topic: string
  learningObjectives: string
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Mixed'
  questionCount: number
  optionCount: 4
  questionType: 'MCQ'
  audience: string
  instructions: string
  language: string
}

export interface AdminQuestionGenerationResult {
  provider: string
  model: string
  questions: AdminQuestionDraft[]
}

export interface AdminAssessmentDraft {
  id: string
  title: string
  instructions: string
  durationMinutes: number
  questions: AdminQuestionDraft[]
}

export interface AdminAssessmentDraftSaved {
  assessmentId: string
  questionCount: number
  published: false
}

export interface AdminConsoleAPI {
  open(): Promise<void>
  close(): Promise<void>
  requestOtp(email: string): Promise<void>
  verifyOtp(email: string, code: string): Promise<void>
  resume(): Promise<boolean>
  getData(): Promise<AdminConsoleData>
  generateQuestions(request: AdminQuestionGenerationRequest): Promise<AdminQuestionGenerationResult>
  saveAssessmentDraft(draft: AdminAssessmentDraft): Promise<AdminAssessmentDraftSaved>
  publishAssessment(assessmentId: string): Promise<{ assessmentId: string; published: true }>
  getInsights(attemptId: string, assessmentId: string): Promise<ProctoringInsightResult>
  recordExport(targetId: 'attempts' | 'events'): Promise<void>
  logout(): Promise<void>
}
