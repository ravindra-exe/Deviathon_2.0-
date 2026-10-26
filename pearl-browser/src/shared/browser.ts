export interface BrowserTabState {
  id: string
  title: string
  url: string
  favicon?: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserState {
  tabs: BrowserTabState[]
  activeTabId: string
  searchEngineUrl: string
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

export interface BrowserAPI {
  getState(): Promise<BrowserState>
  command(command: BrowserCommand): Promise<BrowserState>
  onStateChange(listener: (state: BrowserState) => void): () => void
}
