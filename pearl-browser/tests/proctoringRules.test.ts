import { describe, expect, it } from 'vitest'
import { deriveProctoringInsights } from '../src/renderer/src/components/proctoringRules'
import type { ProctoringRuleEvent } from '../src/renderer/src/components/proctoringRules'

function events(
  type: string,
  count: number,
  observationDurationMs?: number,
  observationCount?: number
): ProctoringRuleEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${type}-${index}`,
    type,
    occurredAt: new Date(index * 1_000).toISOString(),
    storageStatus: 'recorded',
    ...(observationDurationMs === undefined ? {} : { observationDurationMs }),
    ...(observationCount === undefined ? {} : { observationCount })
  }))
}

describe('deriveProctoringInsights', () => {
  it('uses the established medium and high policy-block thresholds', () => {
    expect(deriveProctoringInsights(events('navigation_blocked', 3)).level).toBe('Medium')
    expect(deriveProctoringInsights(events('navigation_blocked', 5)).level).toBe('High')
  })

  it('requires sustained absence and persistent multiple-face evidence', () => {
    expect(deriveProctoringInsights(events('face_not_detected', 1, 4_999)).level).toBe('Low')
    expect(deriveProctoringInsights(events('face_not_detected', 1, 5_000)).level).toBe('Medium')
    expect(deriveProctoringInsights(events('face_not_detected', 3, 5_000)).level).toBe('High')
    expect(deriveProctoringInsights(events('multiple_faces_detected', 1, 2_000, 3)).level).toBe(
      'Medium'
    )
  })

  it('flags repeated camera interruptions for high review', () => {
    expect(deriveProctoringInsights(events('camera_stopped', 1)).level).toBe('Medium')
    expect(deriveProctoringInsights(events('camera_stopped', 2)).level).toBe('High')
  })

  it('does not count events that are not confirmed as recorded', () => {
    const [event] = events('navigation_blocked', 5)
    expect(deriveProctoringInsights([{ ...event, storageStatus: 'pending' }]).level).toBe('Low')
  })
})
