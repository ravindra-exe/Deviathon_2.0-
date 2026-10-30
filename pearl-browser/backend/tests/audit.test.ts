import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminActionAuditStore, AssessmentAuditStore } from '../src/audit'

describe('durable assessment audit log', () => {
  let directory: string | undefined

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  describe('administrator action audit log', () => {
    let directory: string | undefined

    afterEach(() => {
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    })

    it('records actor, export action, target, and timestamp without secrets', () => {
      directory = mkdtempSync(join(tmpdir(), 'pearl-admin-audit-test-'))
      const filePath = join(directory, 'admin-actions.jsonl')
      new AdminActionAuditStore(filePath).record('admin@example.com', 'report_export', 'attempts')
      const event = JSON.parse(readFileSync(filePath, 'utf8').trim()) as Record<string, unknown>
      expect(event.actorEmail).toBe('admin@example.com')
      expect(event.action).toBe('report_export')
      expect(event.targetId).toBe('attempts')
      expect(typeof event.occurredAt).toBe('string')
      expect(event).not.toHaveProperty('token')
    })
  })

  it('appends structured activity and restores it after reopening', () => {
    directory = mkdtempSync(join(tmpdir(), 'pearl-audit-test-'))
    const filePath = join(directory, 'audit.jsonl')
    const firstStore = new AssessmentAuditStore(filePath)
    const recorded = firstStore.append('assessment-1', 'attempt-1', {
      type: 'sustained_head_turn_left',
      confidence: 0.9,
      observationDurationMs: 5_000
    })

    const reopenedStore = new AssessmentAuditStore(filePath)
    expect(reopenedStore.list('attempt-1')).toEqual([recorded])
    expect(reopenedStore.list('attempt-2')).toEqual([])
  })
})
