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
    expect(manager.getState().status).toBe('expired')
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
    await expect(manager.submit()).rejects.toThrow('submitting')
    resolveSubmission!({
      id: 'submission-1',
      submittedAt: new Date().toISOString(),
      status: 'accepted',
      message: 'Accepted locally.'
    })
    expect((await first).status).toBe('submitted')
    expect(manager.getState().events.filter((event) => event.type === 'submitted')).toHaveLength(1)
  })

  it('records a recoverable failed submission and clears the expiration timer', async () => {
    const clock = new ManualClock()
    const manager = new Manager(new FailingSubmissionProvider(), () => undefined, clock)
    await beginAssessment(manager)

    const failed = await manager.submit()
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('Demo provider is unavailable.')
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
