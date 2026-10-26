import { BrowserWindow, dialog, shell, session, DownloadItem } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DownloadRecord } from '../../shared/browser'
import { PersistenceService } from './PersistenceService'

interface DownloadSession {
  on(event: 'will-download', listener: (_event: Electron.Event, item: DownloadItem) => void): void
  off(event: 'will-download', listener: (_event: Electron.Event, item: DownloadItem) => void): void
}

interface DownloadDialog {
  showSaveDialog(
    window: BrowserWindow | Electron.BaseWindow,
    options: Electron.SaveDialogOptions
  ): Promise<Electron.SaveDialogReturnValue>
}

interface DownloadShell {
  showItemInFolder(fullPath: string): void
}

export interface DownloadManagerDependencies {
  downloadSession: DownloadSession
  dialog: DownloadDialog
  shell: DownloadShell
}

export class DownloadManager {
  private readonly items = new Map<string, DownloadItem>()
  private records: DownloadRecord[]
  private nextId = 1
  private readonly dependencies: DownloadManagerDependencies
  private readonly onWillDownload: (_event: Electron.Event, item: DownloadItem) => void

  constructor(
    private readonly window: BrowserWindow | Electron.BaseWindow,
    private readonly persistence: PersistenceService,
    private readonly onChange: () => void,
    dependencies?: Partial<DownloadManagerDependencies>
  ) {
    this.dependencies = {
      downloadSession: dependencies?.downloadSession ?? session.defaultSession,
      dialog: dependencies?.dialog ?? dialog,
      shell: dependencies?.shell ?? shell
    }
    this.records = persistence.snapshot.downloads
    this.onWillDownload = (_event, item) => {
      void this.handleDownload(item)
    }
    this.dependencies.downloadSession.on('will-download', this.onWillDownload)
  }

  getState(): DownloadRecord[] {
    return this.records.map((record) => ({ ...record }))
  }

  cancel(id: string): void {
    this.items.get(id)?.cancel()
  }

  pause(id: string): void {
    const item = this.items.get(id)
    if (item?.canResume()) item.pause()
  }

  resume(id: string): void {
    this.items.get(id)?.resume()
  }

  showFolder(id: string): void {
    const record = this.records.find((item) => item.id === id)
    if (!record?.savePath || !isAbsolute(record.savePath) || !existsSync(record.savePath)) return
    this.dependencies.shell.showItemInFolder(record.savePath)
  }

  dispose(): void {
    this.dependencies.downloadSession.off('will-download', this.onWillDownload)
    this.items.clear()
  }

  private async handleDownload(item: DownloadItem): Promise<void> {
    const id = `download-${this.nextId++}`
    const result = await this.dependencies.dialog.showSaveDialog(this.window, {
      title: 'Save download',
      defaultPath: item.getFilename(),
      buttonLabel: 'Save'
    })
    if (result.canceled || !result.filePath) {
      item.cancel()
      return
    }

    item.setSavePath(result.filePath)
    const record: DownloadRecord = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      savePath: result.filePath,
      status: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : undefined,
      startedAt: new Date().toISOString()
    }
    this.items.set(id, item)
    this.records = [record, ...this.records].slice(0, 500)
    this.persist()
    this.onChange()

    item.on('updated', (_event, state) => {
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes() > 0 ? item.getTotalBytes() : undefined
      record.status =
        state === 'progressing' ? (item.isPaused() ? 'paused' : 'progressing') : 'interrupted'
      this.persist()
      this.onChange()
    })
    item.once('done', (_event, state) => {
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes() > 0 ? item.getTotalBytes() : record.totalBytes
      record.status =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed'
      record.finishedAt = new Date().toISOString()
      this.items.delete(id)
      this.persist()
      this.onChange()
    })
  }

  private persist(): void {
    this.persistence.replaceDownloads(this.records)
  }
}
