import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistenceService } from '../src/main/browser/PersistenceService'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pearl-browser-test-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('PersistenceService', () => {
  it('creates default data and persists all browser metadata', async () => {
    const directory = await createDirectory()
    const first = new PersistenceService(directory)

    expect(first.snapshot.preferences).toEqual({
      searchEngineId: 'google',
      historyEnabled: true,
      restoreSession: false
    })
    first.update((data) => {
      data.bookmarks.push({
        id: 'bookmark-1',
        url: 'https://example.com/',
        title: 'Example',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      data.history.push({
        id: 'history-1',
        url: 'https://example.com/',
        title: 'Example',
        visitedAt: '2026-01-01T00:00:00.000Z'
      })
      data.downloads.push({
        id: 'download-1',
        filename: 'example.txt',
        url: 'https://example.com/example.txt',
        status: 'completed',
        receivedBytes: 10,
        totalBytes: 10,
        startedAt: '2026-01-01T00:00:00.000Z'
      })
      data.preferences.searchEngineId = 'duckduckgo'
      data.preferences.historyEnabled = false
      data.preferences.restoreSession = true
      data.session = { urls: ['https://example.com/'], activeUrl: 'https://example.com/' }
    })

    const reloaded = new PersistenceService(directory)
    expect(reloaded.snapshot.bookmarks).toHaveLength(1)
    expect(reloaded.snapshot.history).toHaveLength(1)
    expect(reloaded.snapshot.downloads[0].filename).toBe('example.txt')
    expect(reloaded.snapshot.preferences.searchEngineId).toBe('duckduckgo')
    expect(reloaded.snapshot.preferences.historyEnabled).toBe(false)
    expect(reloaded.snapshot.session.activeUrl).toBe('https://example.com/')
  })

  it('filters malformed records and invalid URLs', async () => {
    const directory = await createDirectory()
    await writeFile(
      join(directory, 'browser-data.json'),
      JSON.stringify({
        version: 1,
        bookmarks: [
          { id: 'valid', url: 'https://example.com', title: 'Valid', createdAt: 'now' },
          { id: 'invalid-protocol', url: 'file:///secret', title: 'Invalid', createdAt: 'now' },
          { id: 'duplicate', url: 'https://example.com', title: 'Duplicate', createdAt: 'now' }
        ],
        history: [{ id: 'invalid', url: 'javascript:alert(1)', title: 'Bad', visitedAt: 'now' }],
        downloads: [
          {
            id: 'bad',
            filename: 'bad',
            url: 'not a url',
            status: 'completed',
            receivedBytes: 0,
            startedAt: 'now'
          }
        ],
        preferences: { searchEngineId: 'not-allowed', historyEnabled: false, restoreSession: true },
        session: { urls: ['https://safe.example', 'file:///private'], activeUrl: 'file:///private' }
      })
    )

    const service = new PersistenceService(directory)
    expect(service.snapshot.bookmarks).toHaveLength(1)
    expect(service.snapshot.history).toHaveLength(0)
    expect(service.snapshot.downloads).toHaveLength(0)
    expect(service.snapshot.preferences.searchEngineId).toBe('google')
    expect(service.snapshot.session).toEqual({
      urls: ['https://safe.example'],
      activeUrl: undefined
    })
  })

  it('preserves invalid JSON in a timestamped backup', async () => {
    const directory = await createDirectory()
    await writeFile(join(directory, 'browser-data.json'), '{invalid')
    const service = new PersistenceService(directory)
    const files = await readdir(directory)

    expect(service.snapshot.bookmarks).toEqual([])
    expect(files.some((file) => /^browser-data\.json\.corrupt-\d+$/.test(file))).toBe(true)
  })

  it('does not replace in-memory data when an atomic write fails', async () => {
    const directory = await createDirectory()
    const service = new PersistenceService(directory)
    await mkdir(join(directory, 'browser-data.json'))

    expect(() =>
      service.update((data) => {
        data.preferences.historyEnabled = false
      })
    ).toThrow()
    expect(service.snapshot.preferences.historyEnabled).toBe(true)
    await expect(
      readFile(join(directory, 'browser-data.json', 'browser-data.json'))
    ).rejects.toThrow()
  })

  it('serializes each synchronous update without lost state', async () => {
    const directory = await createDirectory()
    const service = new PersistenceService(directory)
    service.update((data) => {
      data.session.urls.push('https://one.example')
    })
    service.update((data) => {
      data.session.urls.push('https://two.example')
    })

    expect(new PersistenceService(directory).snapshot.session.urls).toEqual([
      'https://one.example',
      'https://two.example'
    ])
  })
})
