import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  session: { defaultSession: { on: vi.fn(), off: vi.fn() } },
  shell: { showItemInFolder: vi.fn() }
}))

import { DownloadManager } from '../src/main/browser/DownloadManager'
import { PersistenceService } from '../src/main/browser/PersistenceService'
import type { DownloadItem } from 'electron'

class FakeDownloadItem extends EventEmitter {
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing'
  paused = false
  received = 0
  total = 100
  savePath = ''

  getFilename(): string {
    return 'sample.txt'
  }
  getURL(): string {
    return 'https://downloads.example/sample.txt'
  }
  getTotalBytes(): number {
    return this.total
  }
  getReceivedBytes(): number {
    return this.received
  }
  isPaused(): boolean {
    return this.paused
  }
  canResume(): boolean {
    return true
  }
  pause(): void {
    this.paused = true
    this.emit('updated', {}, 'progressing')
  }
  resume(): void {
    this.paused = false
    this.emit('updated', {}, 'progressing')
  }
  cancel(): void {
    this.state = 'cancelled'
    this.emit('done', {}, 'cancelled')
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('DownloadManager', () => {
  it('tracks progress, pause/resume, completion, cancellation, and cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pearl-browser-download-test-'))
    directories.push(directory)
    const persistence = new PersistenceService(directory)
    const listeners = new Set<(event: Electron.Event, item: DownloadItem) => void>()
    const downloadSession = {
      on: (
        _event: 'will-download',
        listener: (event: Electron.Event, item: DownloadItem) => void
      ) => listeners.add(listener),
      off: (
        _event: 'will-download',
        listener: (event: Electron.Event, item: DownloadItem) => void
      ) => listeners.delete(listener)
    }
    const manager = new DownloadManager({} as never, persistence, vi.fn(), {
      downloadSession,
      dialog: {
        showSaveDialog: vi
          .fn()
          .mockResolvedValue({ canceled: false, filePath: join(directory, 'sample.txt') })
      },
      shell: { showItemInFolder: vi.fn() }
    })
    const item = new FakeDownloadItem()
    for (const listener of listeners)
      listener({} as Electron.Event, item as unknown as DownloadItem)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(manager.getState()[0]).toMatchObject({ status: 'progressing', filename: 'sample.txt' })
    item.received = 40
    item.emit('updated', {}, 'progressing')
    expect(manager.getState()[0].receivedBytes).toBe(40)
    manager.pause(manager.getState()[0].id)
    expect(manager.getState()[0].status).toBe('paused')
    manager.resume(manager.getState()[0].id)
    expect(manager.getState()[0].status).toBe('progressing')

    item.state = 'completed'
    item.received = 100
    item.emit('done', {}, 'completed')
    expect(manager.getState()[0].status).toBe('completed')
    expect(new PersistenceService(directory).snapshot.downloads[0].status).toBe('completed')

    const cancelled = new FakeDownloadItem()
    for (const listener of listeners)
      listener({} as Electron.Event, cancelled as unknown as DownloadItem)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const cancelledId = manager.getState()[0].id
    manager.cancel(cancelledId)
    expect(manager.getState().find((record) => record.id === cancelledId)?.status).toBe('cancelled')

    manager.dispose()
    expect(listeners).toHaveLength(0)
  })
})
