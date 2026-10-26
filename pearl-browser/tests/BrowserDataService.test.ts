import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserDataService } from '../src/main/browser/BrowserDataService'
import { NavigationService } from '../src/main/browser/NavigationService'
import { PersistenceService } from '../src/main/browser/PersistenceService'
import type { BrowserTabState } from '../src/shared/browser'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createDataService(): Promise<{
  data: BrowserDataService
  persistence: PersistenceService
}> {
  const directory = await mkdtemp(join(tmpdir(), 'pearl-browser-data-test-'))
  directories.push(directory)
  const persistence = new PersistenceService(directory)
  return { data: new BrowserDataService(persistence, new NavigationService()), persistence }
}

const tab = (url: string, title = 'Example'): BrowserTabState => ({
  id: 'tab-1',
  url,
  title,
  isLoading: false,
  canGoBack: false,
  canGoForward: false
})

describe('BrowserDataService', () => {
  it('adds and removes bookmarks without duplicates', async () => {
    const { data, persistence } = await createDataService()
    data.addBookmark(tab('https://example.com'))
    data.addBookmark(tab('https://example.com'))
    expect(persistence.snapshot.bookmarks).toHaveLength(1)
    data.removeBookmark(persistence.snapshot.bookmarks[0].id)
    expect(persistence.snapshot.bookmarks).toEqual([])
  })

  it('records permitted visits, supports search/removal/clear, and respects the preference', async () => {
    const { data, persistence } = await createDataService()
    data.recordVisit(tab('https://example.com', 'Example page'))
    data.recordVisit(tab('file:///private', 'Private'))
    expect(data.searchHistory('example')).toHaveLength(1)
    expect(data.searchHistory('missing')).toHaveLength(0)

    persistence.update((stored) => {
      stored.preferences.historyEnabled = false
    })
    data.recordVisit(tab('https://another.example', 'Another'))
    expect(persistence.snapshot.history).toHaveLength(1)

    data.removeHistory(persistence.snapshot.history[0].id)
    expect(persistence.snapshot.history).toHaveLength(0)
    data.recordVisit(tab('https://third.example'))
    data.clearHistory()
    expect(persistence.snapshot.history).toEqual([])
  })
})
