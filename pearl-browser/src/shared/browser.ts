import type { AssessmentAPI } from './assessment'

export interface BrowserTabState {
  id: string
  title: string
  url: string
  favicon?: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  errorCode?: number
  errorMessage?: string
  failedUrl?: string
  navigationState: NavigationState
}

export type NavigationState = 'idle' | 'loading' | 'loaded' | 'failed' | 'recovering'

export interface Bookmark {
  id: string
  url: string
  title: string
  favicon?: string
  createdAt: string
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: string
}

export type DownloadStatus =
  'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'

export interface DownloadRecord {
  id: string
  filename: string
  url: string
  savePath?: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes?: number
  startedAt: string
  finishedAt?: string
}

export interface SearchEngine {
  id: 'google' | 'bing' | 'duckduckgo'
  label: string
  searchUrl: string
}

export interface BrowserPreferences {
  searchEngineId: SearchEngine['id']
  historyEnabled: boolean
  restoreSession: boolean
}

export interface BrowserState {
  tabs: BrowserTabState[]
  activeTabId: string
  searchEngineUrl: string
  bookmarks: Bookmark[]
  history: HistoryEntry[]
  downloads: DownloadRecord[]
  preferences: BrowserPreferences
}

export interface BrowserTabsState {
  tabs: BrowserTabState[]
  activeTabId: string
}

export type BrowserCommand =
  | { type: 'create-tab'; url?: string }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'navigate'; input: string }
  | { type: 'go-back' }
  | { type: 'go-forward' }
  | { type: 'reload' }
  | { type: 'stop-loading' }
  | { type: 'add-bookmark' }
  | { type: 'remove-bookmark'; bookmarkId: string }
  | { type: 'navigate-to-url'; url: string }
  | { type: 'remove-history'; historyId: string }
  | { type: 'clear-history' }
  | { type: 'set-history-enabled'; enabled: boolean }
  | { type: 'set-search-engine'; engineId: SearchEngine['id'] }
  | { type: 'set-restore-session'; enabled: boolean }
  | { type: 'cancel-download'; downloadId: string }
  | { type: 'pause-download'; downloadId: string }
  | { type: 'resume-download'; downloadId: string }
  | { type: 'show-download-folder'; downloadId: string }
  | { type: 'set-panel-open'; open: boolean }

export interface BrowserAPI {
  getState(): Promise<BrowserState>
  command(command: BrowserCommand): Promise<BrowserState>
  onStateChange(listener: (state: BrowserState) => void): () => void
  onFocusAddress(listener: () => void): () => void
  assessment: AssessmentAPI
}
