import { describe, expect, it } from 'vitest'
import type { AssessmentClock, AssessmentManager } from '../src/main/browser/AssessmentManager'
import { AssessmentManager as Manager } from '../src/main/browser/AssessmentManager'
import {
  LocalDemoAssessmentProvider,
  type AssessmentProvider
} from '../src/main/browser/AssessmentProvider'
import type { AssessmentConfiguration, AssessmentSubmission } from '../src/shared/assessment'

class ManualClock implements AssessmentClock {
  current = Date.parse('2026-01-01T00:00:00.000Z')
  callbacks: Array<() => void> = []

  now(): number {
    return this.current
  }

  setTimeout(callback: () => void): NodeJS.Timeout {
    this.callbacks.push(callback)
    return {} as NodeJS.Timeout
  }

  clearTimeout(timer: NodeJS.Timeout): void {
    void timer
  }

  advance(milliseconds: number): void {
    this.current += milliseconds
  }

  fireTimers(): void {
    const callbacks = this.callbacks.splice(0)
    callbacks.forEach((callback) => callback())
  }

  fireFirstTimer(): void {
    this.callbacks.shift()?.()
  }
}

async function beginAssessment(manager: AssessmentManager): Promise<AssessmentConfiguration> {
  await manager.start()
  await manager.authenticate('Participant', 'DEMO')
  await manager.begin()
  return manager.getState().configuration!
}

class FailingSubmissionProvider extends LocalDemoAssessmentProvider {
  override async submitAnswers(
    configuration: AssessmentConfiguration,
    answers: ReadonlyArray<{ questionId: string; optionIndex: number }>
  ): Promise<AssessmentSubmission> {
    void configuration
    void answers
    throw new Error('Demo provider is unavailable.')
  }
}

describe('AssessmentManager', () => {
  it('enforces the demo lifecycle and keeps answers in the main-process state', async () => {
    const manager = new Manager(new LocalDemoAssessmentProvider(), () => undefined)
    expect(manager.getState().status).toBe('idle')

    await manager.start()
    expect(manager.getState().status).toBe('ready')
    await manager.authenticate('Participant', 'DEMO')
    await manager.begin()
    expect(manager.getState().status).toBe('in_progress')

    const question = manager.getState().configuration!.questions[0]
    manager.answer(question.id, 1)
    expect(manager.getState().answers).toEqual([{ questionId: question.id, optionIndex: 1 }])

    await expect(manager.authenticate('Other', 'DEMO')).rejects.toThrow()
    const submitted = await manager.submit()
    expect(submitted.status).toBe('submitted')
    expect(submitted.submission?.status).toBe('accepted')
  })

  it('loads remote questions only after authentication when the participant starts', async () => {
    const local = new LocalDemoAssessmentProvider()
    const fullConfiguration = await local.getConfiguration()
    let questionLoads = 0
    const provider: AssessmentProvider = {
      getConfiguration: async () => ({
        ...fullConfiguration,
        provider: 'remote-backend',
        questions: [],
        questionCount: fullConfiguration.questions.length
      }),
      authenticate: (displayName, demoCode) => local.authenticate(displayName, demoCode),
      authenticateOtp: async () => ({
        id: 'verified-participant',
        displayName: 'participant@example.com',
        provider: 'remote-backend',
        demoOnly: false
      }),
      loadQuestions: async () => {
        questionLoads += 1
        return fullConfiguration.questions
      },
      startAttempt: async () => ({ attemptId: 'attempt-1' }),
      submitAnswers: (configuration, answers) => local.submitAnswers(configuration, answers)
    }
    const manager = new Manager(provider, () => undefined)

    await manager.start()
    expect(manager.getState().configuration?.questions).toEqual([])
    expect(questionLoads).toBe(0)
    await manager.authenticate('participant@example.com', '123456')
    expect(questionLoads).toBe(0)
    await expect(manager.begin()).rejects.toThrow('acknowledge the assessment policy')
    manager.acknowledgePolicy(true)
    await manager.begin()

    expect(questionLoads).toBe(1)
    expect(manager.getState().configuration?.questions).toHaveLength(3)
    expect(manager.getState().status).toBe('in_progress')
  })

  it('submits automatically at the deadline and retains the deadline trigger for retries', async () => {
    const clock = new ManualClock()
    const local = new LocalDemoAssessmentProvider()
    const triggers: Array<string | undefined> = []
    let failFirst = true
    const provider: AssessmentProvider = {
      getConfiguration: () => local.getConfiguration(),
      authenticate: (name, code) => local.authenticate(name, code),
      submitAnswers: async (configuration, answers, attemptId, trigger) => {
        void attemptId
        triggers.push(trigger)
        if (failFirst) {
          failFirst = false
          throw new Error('Temporary submission failure.')
        }
        return local.submitAnswers(configuration, answers)
      }
    }
    const manager = new Manager(provider, () => undefined, clock)
    await manager.start()
    await manager.authenticate('Participant', 'DEMO')
    await manager.begin()

    clock.advance(10 * 60_000)
    clock.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.getState().status).toBe('expired')
    expect(manager.getState().automaticSubmissionTrigger).toBe('deadline')

    const retried = await manager.submit()
    expect(retried.status).toBe('submitted')
    expect(triggers).toEqual(['deadline', 'deadline'])
  })

  it('keeps OTP request and verification errors on the ready sign-in state', async () => {
    const local = new LocalDemoAssessmentProvider()
    const provider: AssessmentProvider = {
      getConfiguration: () => local.getConfiguration(),
      authenticate: (displayName, demoCode) => local.authenticate(displayName, demoCode),
      requestOtp: async () => {
        throw new Error('OTP delivery unavailable.')
      },
      authenticateOtp: async () => {
        throw new Error('Authentication failed.')
      },
      submitAnswers: (configuration, answers) => local.submitAnswers(configuration, answers)
    }
    const manager = new Manager(provider, () => undefined)
    await manager.start()

    await expect(manager.requestOtp('participant@example.com')).rejects.toThrow(
      'OTP delivery unavailable.'
    )
    await expect(manager.authenticate('participant@example.com', '000000')).rejects.toThrow(
      'Authentication failed.'
    )
    expect(manager.getState().status).toBe('ready')
    expect(manager.getState().participant).toBeUndefined()
  })

  it('rejects invalid answers and uses explicit host matching for policy checks', async () => {
    const manager = new Manager(new LocalDemoAssessmentProvider(), () => undefined)
    await manager.start()
    await manager.authenticate('Participant', 'DEMO')
    await manager.begin()
    const question = manager.getState().configuration!.questions[0]

    expect(() => manager.answer(question.id, 99)).toThrow()
    expect(manager.canNavigate('https://example.com')).toBe(false)
    expect(manager.canNavigate('https://example.com.evil.test')).toBe(false)
  })

  it('uses the authoritative deadline and automatically submits at expiration', async () => {
    const clock = new ManualClock()
    const manager = new Manager(new LocalDemoAssessmentProvider(), () => undefined, clock)
    const configuration = await beginAssessment(manager)

    expect(Date.parse(manager.getState().deadline!) - clock.now()).toBe(
      configuration.policy.durationMinutes * 60_000
    )
    clock.advance(configuration.policy.durationMinutes * 60_000)
    clock.fireTimers()
    await Promise.resolve()

    expect(manager.getState().status).toBe('submitted')
    expect(manager.getState().events.map((event) => event.type)).toContain('expired')
    expect(manager.getState().events.map((event) => event.type)).toContain('submitted')
  })

  it('rejects answers at the deadline', async () => {
    const clock = new ManualClock()
    const manager = new Manager(new LocalDemoAssessmentProvider(), () => undefined, clock)
    const configuration = await beginAssessment(manager)
    clock.advance(configuration.policy.durationMinutes * 60_000)

    expect(() => manager.answer(configuration.questions[0].id, 0)).toThrow(
      'Assessment time has expired.'
    )
    expect(manager.getState().status).toBe('submitting')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.getState().status).toBe('submitted')
  })

  it('routes a manual submit at the deadline through the deadline coordinator', async () => {
    const clock = new ManualClock()
    const baseProvider = new LocalDemoAssessmentProvider()
    let receivedTrigger: string | undefined
    const provider: AssessmentProvider = {
      getConfiguration: () => baseProvider.getConfiguration(),
      authenticate: (name, code) => baseProvider.authenticate(name, code),
      submitAnswers: async (configuration, answers, attemptId, trigger) => {
        void attemptId
        receivedTrigger = trigger
        return baseProvider.submitAnswers(configuration, answers)
      }
    }
    const manager = new Manager(provider, () => undefined, clock)
    const configuration = await beginAssessment(manager)
    clock.advance(configuration.policy.durationMinutes * 60_000)

    const submitted = await manager.submit()
    expect(submitted.status).toBe('submitted')
    expect(receivedTrigger).toBe('deadline')
  })

  it('prevents duplicate submissions while a provider request is pending', async () => {
    let resolveSubmission: ((submission: AssessmentSubmission) => void) | undefined
    const baseProvider = new LocalDemoAssessmentProvider()
    const provider: AssessmentProvider = {
      getConfiguration: () => baseProvider.getConfiguration(),
      authenticate: (displayName, demoCode) => baseProvider.authenticate(displayName, demoCode),
      submitAnswers: () =>
        new Promise<AssessmentSubmission>((resolve) => {
          resolveSubmission = resolve
        })
    }
    const manager = new Manager(provider, () => undefined)
    await beginAssessment(manager)

    const first = manager.submit()
    expect(manager.getState().status).toBe('submitting')
    expect(manager.submit()).toBe(first)
    resolveSubmission!({
      id: 'submission-1',
      submittedAt: new Date().toISOString(),
      status: 'accepted',
      message: 'Accepted locally.'
    })
    expect((await first).status).toBe('submitted')
    expect(manager.getState().events.filter((event) => event.type === 'submitted')).toHaveLength(1)
  })

  it('records automatic integrity triggers and submits the latest answers only once', async () => {
    const baseProvider = new LocalDemoAssessmentProvider()
    const configuration = await baseProvider.getConfiguration()
    const recordedTypes: string[] = []
    let submissions = 0
    const provider: AssessmentProvider = {
      getConfiguration: async () => ({
        ...configuration,
        provider: 'remote-backend'
      }),
      authenticate: (displayName, demoCode) => baseProvider.authenticate(displayName, demoCode),
      startAttempt: async () => ({ attemptId: 'live-attempt-for-test' }),
      recordActivityEvent: async (event) => {
        recordedTypes.push(event.type)
        return { id: `event-${recordedTypes.length}`, occurredAt: new Date().toISOString() }
      },
      submitAnswers: async (assessment, answers) => {
        submissions += 1
        expect(answers).toEqual([{ questionId: assessment.questions[0].id, optionIndex: 2 }])
        return baseProvider.submitAnswers(assessment, answers)
      }
    }
    const manager = new Manager(provider, () => undefined)
    await manager.start()
    await manager.authenticate('Participant', 'DEMO')
    manager.acknowledgePolicy(true)
    await manager.begin()
    manager.answer(configuration.questions[0].id, 2)

    const focusLoss = manager.submit('focus_loss')
    const duplicateFocusLoss = manager.submit('focus_loss')
    const minimized = manager.submit('minimized')
    const [submitted] = await Promise.all([focusLoss, duplicateFocusLoss, minimized])

    expect(submitted.status).toBe('submitted')
    expect(submissions).toBe(1)
    expect(recordedTypes).toContain('automatic_submission_focus_loss')
    expect(recordedTypes).toContain('automatic_submission_minimized')
    expect(recordedTypes.filter((type) => type === 'automatic_submission_focus_loss')).toHaveLength(
      1
    )
    expect(submitted.automaticSubmissionTrigger).toBe('focus_loss')
  })

  it('does not wait for activity storage before sending automatic submissions', async () => {
    const baseProvider = new LocalDemoAssessmentProvider()
    const configuration = await baseProvider.getConfiguration()
    let resolveActivity: (() => void) | undefined
    let submissionStarted = false
    const provider: AssessmentProvider = {
      getConfiguration: async () => ({
        ...configuration,
        provider: 'remote-backend'
      }),
      authenticate: (displayName, demoCode) => baseProvider.authenticate(displayName, demoCode),
      startAttempt: async () => ({ attemptId: 'live-attempt-with-slow-audit' }),
      recordActivityEvent: () =>
        new Promise((resolve) => {
          resolveActivity = () =>
            resolve({ id: 'slow-audit-event', occurredAt: new Date().toISOString() })
        }),
      submitAnswers: async (assessment, answers) => {
        submissionStarted = true
        return baseProvider.submitAnswers(assessment, answers)
      }
    }
    const manager = new Manager(provider, () => undefined)
    await manager.start()
    await manager.authenticate('Participant', 'DEMO')
    manager.acknowledgePolicy(true)
    await manager.begin()

    const submission = manager.submit('focus_loss')
    await Promise.resolve()

    expect(submissionStarted).toBe(true)
    expect(manager.getState().status).toBe('submitting')
    resolveActivity?.()
    expect((await submission).status).toBe('submitted')
  })

  it('records a recoverable failed submission and clears the expiration timer', async () => {
    const clock = new ManualClock()
    const manager = new Manager(new FailingSubmissionProvider(), () => undefined, clock)
    await beginAssessment(manager)

    const failed = await manager.submit()
    expect(failed.status).toBe('in_progress')
    expect(failed.error).toContain('Demo provider is unavailable.')
    expect(failed.submissionFailure).toContain('Demo provider is unavailable.')
    await expect(manager.cancel()).rejects.toThrow('Retry the failed submission')
    expect(failed.events.map((event) => event.type)).toContain('failed')
  })

  it('keeps manual submission authoritative when expiration fires concurrently', async () => {
    const clock = new ManualClock()
    let resolveSubmission: ((submission: AssessmentSubmission) => void) | undefined
    const baseProvider = new LocalDemoAssessmentProvider()
    const provider: AssessmentProvider = {
      getConfiguration: () => baseProvider.getConfiguration(),
      authenticate: (displayName, demoCode) => baseProvider.authenticate(displayName, demoCode),
      submitAnswers: () =>
        new Promise<AssessmentSubmission>((resolve) => {
          resolveSubmission = resolve
        })
    }
    const manager = new Manager(provider, () => undefined, clock)
    const configuration = await beginAssessment(manager)
    const manualSubmission = manager.submit()
    clock.advance(configuration.policy.durationMinutes * 60_000)
    clock.fireTimers()
    expect(manager.getState().status).toBe('submitting')

    resolveSubmission!({
      id: 'manual-submission',
      submittedAt: new Date().toISOString(),
      status: 'accepted',
      message: 'Accepted locally.'
    })
    expect((await manualSubmission).status).toBe('submitted')
    expect(
      manager.getState().events.filter((event) => event.type === 'submission_started')
    ).toHaveLength(1)
  })

  it('ignores a stale expiration callback after a new session begins', async () => {
    const clock = new ManualClock()
    const manager = new Manager(new LocalDemoAssessmentProvider(), () => undefined, clock)
    await beginAssessment(manager)
    await manager.cancel()
    await beginAssessment(manager)

    clock.fireFirstTimer()
    expect(manager.getState().status).toBe('in_progress')
  })
})
