import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Bookmark,
  BrowserPreferences,
  DownloadRecord,
  HistoryEntry
} from '../../shared/browser'

export interface PersistedBrowserData {
  version: 1
  bookmarks: Bookmark[]
  history: HistoryEntry[]
  downloads: DownloadRecord[]
  preferences: BrowserPreferences
  session: { urls: string[]; activeUrl?: string }
}

const DEFAULT_PREFERENCES: BrowserPreferences = {
  searchEngineId: 'google',
  historyEnabled: true,
  restoreSession: false
}

const emptyData = (): PersistedBrowserData => ({
  version: 1,
  bookmarks: [],
  history: [],
  downloads: [],
  preferences: { ...DEFAULT_PREFERENCES },
  session: { urls: [] }
})

export class PersistenceService {
  private readonly filePath: string
  private data: PersistedBrowserData

  constructor(directory?: string) {
    const storageDirectory = directory ?? app.getPath('userData')
    mkdirSync(storageDirectory, { recursive: true })
    this.filePath = join(storageDirectory, 'browser-data.json')
    this.data = this.read()
  }

  get snapshot(): PersistedBrowserData {
    return structuredClone(this.data)
  }

  update(mutator: (data: PersistedBrowserData) => void): void {
    const next = structuredClone(this.data)
    mutator(next)
    const validated = validateData(next)
    this.write(validated)
    this.data = validated
  }

  replaceDownloads(downloads: DownloadRecord[]): void {
    this.update((data) => {
      data.downloads = downloads
    })
  }

  private read(): PersistedBrowserData {
    if (!existsSync(this.filePath)) return emptyData()
    try {
      return validateData(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, backupPath)
        console.warn(`Browser data was invalid and moved to ${backupPath}`, error)
      } catch (backupError) {
        console.error('Unable to preserve corrupted browser data', backupError)
      }
      return emptyData()
    }
  }

  private write(data: PersistedBrowserData): void {
    const temporaryPath = `${this.filePath}.tmp`
    try {
      writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      console.error('Unable to persist browser data', error)
      throw error
    }
  }
}

function validateData(value: unknown): PersistedBrowserData {
  if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported browser data version')
  const preferences = isRecord(value.preferences) ? value.preferences : {}
  const data = emptyData()
  data.bookmarks = validBookmarks(value.bookmarks)
  data.history = validHistory(value.history)
  data.downloads = validDownloads(value.downloads)
  data.preferences = {
    searchEngineId:
      preferences.searchEngineId === 'bing' || preferences.searchEngineId === 'duckduckgo'
        ? preferences.searchEngineId
        : 'google',
    historyEnabled: preferences.historyEnabled !== false,
    restoreSession: preferences.restoreSession === true
  }
  if (isRecord(value.session) && Array.isArray(value.session.urls)) {
    data.session = {
      urls: value.session.urls.filter((url): url is string => isWebUrl(url)).slice(0, 50),
      activeUrl:
        typeof value.session.activeUrl === 'string' && isWebUrl(value.session.activeUrl)
          ? value.session.activeUrl
          : undefined
    }
  }
  return data
}

function validBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isBookmark)
    .filter((item, index, list) => list.findIndex((other) => other.url === item.url) === index)
    .slice(0, 1000)
}

function validHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isHistoryEntry)
    .filter((item) => isWebUrl(item.url))
    .slice(0, 5000)
}

function validDownloads(value: unknown): DownloadRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isDownloadRecord)
    .filter((item) => isWebUrl(item.url))
    .slice(-500)
}

function isBookmark(value: unknown): value is Bookmark {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    isWebUrl(value.url) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string'
  )
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.visitedAt === 'string'
  )
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.url === 'string' &&
    typeof value.status === 'string' &&
    typeof value.receivedBytes === 'number' &&
    typeof value.startedAt === 'string'
  )
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
