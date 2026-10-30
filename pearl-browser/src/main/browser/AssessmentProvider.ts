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

export interface AssessmentIdentityProvider {
  authenticate(displayName: string, demoCode: string): Promise<AssessmentParticipant>
  authenticateOtp?(email: string, code: string): Promise<AssessmentParticipant>
}

export interface AssessmentProvider extends AssessmentIdentityProvider {
  getConfiguration(): Promise<AssessmentConfiguration>
  loadQuestions?(configuration: AssessmentConfiguration): Promise<AssessmentQuestion[]>
  logout?(): Promise<void>
  startAttempt?(
    configuration: AssessmentConfiguration,
    participant: AssessmentParticipant
  ): Promise<{ attemptId: string; startedAt?: string; deadline?: string }>
  submitAnswers(
    configuration: AssessmentConfiguration,
    answers: ReadonlyArray<{ questionId: string; optionIndex: number }>,
    attemptId?: string,
    trigger?: AutomaticSubmissionTrigger
  ): Promise<AssessmentSubmission>
  requestOtp?(email: string, assessmentId: string): Promise<void>
  recordActivityEvent?(
    event: AssessmentActivityEvent,
    attemptId: string
  ): Promise<AssessmentActivityReceipt>
  getProctoringInsights?(attemptId: string, assessmentId: string): Promise<ProctoringInsightResult>
}

export class LocalDemoAssessmentProvider implements AssessmentProvider {
  async getConfiguration(): Promise<AssessmentConfiguration> {
    return {
      id: 'pearl-demo-assessment',
      provider: 'local-demo',
      title: 'Pearl Browser Demonstration Examination',
      instructions:
        'This local demonstration is for testing the assessment interface only. It is not identity verification or a secure proctored examination.',
      policy: {
        allowedHosts: ['127.0.0.1'],
        blockedHosts: [],
        allowSubdomains: false,
        localDevelopmentHosts: ['127.0.0.1'],
        allowHttpLocalDevelopment: true,
        allowNewTabs: false,
        allowPopupDestinations: false,
        activeTabOnly: true,
        allowLeavingAssessment: false,
        durationMinutes: 10,
        recordHistory: false,
        warningOnRestrictedAction: true,
        cameraMonitoring: false,
        expirationBehavior: 'submit',
        cancellationBehavior: 'return-to-browser'
      },
      questions: [
        {
          id: 'q1',
          prompt: 'Which process owns the authoritative assessment session in Pearl Browser?',
          options: [
            { id: 'A', text: 'The webpage' },
            { id: 'B', text: 'The React renderer' },
            { id: 'C', text: 'The Electron main process' },
            { id: 'D', text: 'The CSS layer' }
          ]
        },
        {
          id: 'q2',
          prompt: 'Which protocol is allowed for ordinary secure web navigation?',
          options: [
            { id: 'A', text: 'file:' },
            { id: 'B', text: 'javascript:' },
            { id: 'C', text: 'https:' },
            { id: 'D', text: 'data:' }
          ]
        },
        {
          id: 'q3',
          prompt: 'What does the local demo provider represent?',
          options: [
            { id: 'A', text: 'Production identity verification' },
            { id: 'B', text: 'A replaceable local demonstration provider' },
            { id: 'C', text: 'An external exam backend' },
            { id: 'D', text: 'AI proctoring' }
          ]
        }
      ]
    }
  }

  async authenticate(displayName: string, demoCode: string): Promise<AssessmentParticipant> {
    const name = displayName.trim()
    if (!name || demoCode.trim().toUpperCase() !== 'DEMO') {
      throw new Error('Use a display name and the demonstration code DEMO.')
    }

    return {
      id: `demo-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40)}`,
      displayName: name,
      provider: 'local-demo',
      demoOnly: true
    }
  }

  async startAttempt(): Promise<{ attemptId: string }> {
    return { attemptId: `demo-attempt-${Date.now()}` }
  }

  async submitAnswers(
    configuration: AssessmentConfiguration,
    answers: ReadonlyArray<{ questionId: string; optionIndex: number }>
  ): Promise<AssessmentSubmission> {
    if (configuration.questions.length === 0 || answers.some((answer) => !answer.questionId)) {
      throw new Error('Demo submission contains invalid assessment data.')
    }
    return {
      id: `demo-submission-${Date.now()}`,
      submittedAt: new Date().toISOString(),
      status: 'accepted',
      message: 'Demo submission accepted locally. This is not a production examination result.'
    }
  }
}
