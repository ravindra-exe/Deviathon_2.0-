import { describe, expect, it } from 'vitest'
import { isBrowserCommand } from '../src/main/browser/CommandValidation'

describe('browser command validation', () => {
  it('accepts the explicit command allowlist and rejects malformed payloads', () => {
    expect(isBrowserCommand({ type: 'reload' })).toBe(true)
    expect(isBrowserCommand({ type: 'navigate', input: 'https://example.com' })).toBe(true)
    expect(isBrowserCommand({ type: 'set-search-engine', engineId: 'bing' })).toBe(true)
    expect(isBrowserCommand({ type: 'set-search-engine', engineId: 'custom' })).toBe(false)
    expect(isBrowserCommand({ type: 'navigate', input: '' })).toBe(false)
    expect(isBrowserCommand({ type: 'navigate', input: 'x'.repeat(2049) })).toBe(false)
    expect(isBrowserCommand({ type: 'show-download-folder', downloadId: '../private' })).toBe(true)
    expect(isBrowserCommand({ type: 'run-shell', command: 'dir' })).toBe(false)
    expect(isBrowserCommand(null)).toBe(false)
  })
})
