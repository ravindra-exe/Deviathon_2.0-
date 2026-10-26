import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserTabState, BrowserTabsState } from '../../shared/browser'
import { NavigationService } from './NavigationService'

const NEW_TAB_URL = 'https://www.google.com'

interface ManagedTab {
  state: BrowserTabState
  view: WebContentsView
  pendingVisitUrl?: string
}

export class TabManager {
  private readonly tabs = new Map<string, ManagedTab>()
  private activeTabId = ''
  private nextId = 1

  constructor(
    private readonly window: BrowserWindow | Electron.BaseWindow,
    private readonly navigation: NavigationService,
    private readonly onChange: () => void,
    private readonly onVisit: (tab: BrowserTabState) => void
  ) {}

  createTab(input = NEW_TAB_URL): string {
    const id = `tab-${this.nextId++}`
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const tab: ManagedTab = {
      view,
      state: {
        id,
        title: 'New tab',
        url: input,
        isLoading: true,
        canGoBack: false,
        canGoForward: false
      }
    }
    this.tabs.set(id, tab)
    this.window.contentView.addChildView(view)
    this.attachEvents(tab)
    this.activateTab(id)
    void view.webContents.loadURL(this.navigation.normalize(input))
    return id
  }

  activateTab(id: string): void {
    if (!this.tabs.has(id)) return
    this.activeTabId = id
    for (const [tabId, tab] of this.tabs) {
      tab.view.setVisible(tabId === id)
    }
    this.onChange()
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.tabs.delete(id)

    if (this.tabs.size === 0) {
      this.createTab()
      return
    }
    if (this.activeTabId === id) {
      this.activateTab(this.tabs.keys().next().value as string)
    } else {
      this.onChange()
    }
  }

  navigate(input: string): void {
    const tab = this.activeTab
    if (!tab) return
    void tab.view.webContents.loadURL(this.navigation.normalize(input))
  }

  goBack(): void {
    if (this.activeTab?.view.webContents.navigationHistory.canGoBack())
      this.activeTab.view.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    if (this.activeTab?.view.webContents.navigationHistory.canGoForward())
      this.activeTab.view.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.activeTab?.view.webContents.reload()
  }

  stopLoading(): void {
    this.activeTab?.view.webContents.stop()
  }

  resize(width: number, height: number): void {
    for (const tab of this.tabs.values()) {
      tab.view.setBounds({ x: 0, y: 156, width, height: Math.max(0, height - 156) })
    }
  }

  getState(): BrowserTabsState {
    return {
      tabs: [...this.tabs.values()].map(({ state }) => ({ ...state })),
      activeTabId: this.activeTabId
    }
  }

  destroy(): void {
    for (const tab of this.tabs.values()) tab.view.webContents.close()
    this.tabs.clear()
  }

  private get activeTab(): ManagedTab | undefined {
    return this.tabs.get(this.activeTabId)
  }

  private attachEvents(tab: ManagedTab): void {
    const { webContents } = tab.view
    webContents.on('did-start-loading', () => {
      tab.state.isLoading = true
      this.onChange()
    })
    webContents.on('did-stop-loading', () => {
      tab.state.isLoading = false
      this.syncState(tab)
      if (tab.pendingVisitUrl && tab.pendingVisitUrl === tab.state.url) {
        this.onVisit({ ...tab.state })
        tab.pendingVisitUrl = undefined
      }
    })
    webContents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      tab.state.title = title || 'New tab'
      this.onChange()
    })
    webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.state.favicon = favicons[0]
      this.onChange()
    })
    webContents.on('did-navigate', () => {
      tab.pendingVisitUrl = tab.view.webContents.getURL()
      this.syncState(tab)
    })
    webContents.on('did-navigate-in-page', () => this.syncState(tab))
    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        tab.state.isLoading = false
        tab.state.title = 'Unable to load page'
        tab.state.url = validatedURL
        console.warn(`Navigation failed (${errorCode}): ${errorDescription}`)
        this.onChange()
      }
    )
    webContents.on('will-navigate', (event, url) => {
      if (!this.navigation.isWebUrl(url)) {
        event.preventDefault()
        this.navigation.openExternal(url)
      }
    })
    webContents.setWindowOpenHandler(({ url }) => {
      console.info('Blocked popup:', url)
      return { action: 'deny' }
    })
  }

  private syncState(tab: ManagedTab): void {
    const previousUrl = tab.state.url
    tab.state.url = tab.view.webContents.getURL()
    tab.state.canGoBack = tab.view.webContents.navigationHistory.canGoBack()
    tab.state.canGoForward = tab.view.webContents.navigationHistory.canGoForward()
    tab.state.isLoading = false
    if (tab.state.url !== previousUrl && !this.navigation.isWebUrl(tab.state.url))
      tab.pendingVisitUrl = undefined
    this.onChange()
  }

  getRestorableSession(): { urls: string[]; activeUrl?: string } {
    const tabs = [...this.tabs.values()]
      .map(({ state }) => state.url)
      .filter((url) => this.navigation.isWebUrl(url))
    const activeUrl = this.activeTab?.state.url
    return {
      urls: tabs,
      activeUrl: activeUrl && this.navigation.isWebUrl(activeUrl) ? activeUrl : undefined
    }
  }
}
