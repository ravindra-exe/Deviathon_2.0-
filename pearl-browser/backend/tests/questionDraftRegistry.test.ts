import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssessmentDraftRegistry } from '../src/questionDraftRegistry'

describe('AssessmentDraftRegistry', () => {
  it('restores generator-owned assessment IDs after a backend restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pearl-question-drafts-'))
    try {
      const path = join(directory, 'drafts.jsonl')
      const registry = new AssessmentDraftRegistry(path)
      await registry.register('generated-paper-1')

      const reloaded = new AssessmentDraftRegistry(path)
      expect(reloaded.has('generated-paper-1')).toBe(true)
      expect(reloaded.has('unrelated-existing-assessment')).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
