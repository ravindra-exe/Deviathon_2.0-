import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserTabState, BrowserTabsState } from '../../shared/browser'
import type { AssessmentActivityEvent } from '../../shared/assessment'
import { calculateBrowserLayout } from './Layout'
import { readNavigationHistory } from './NavigationHistory'
import { describeNavigationError, NavigationService } from './NavigationService'

const NEW_TAB_URL = 'about:blank'

interface ManagedTab {
  state: BrowserTabState
  view: WebContentsView
  pendingVisitUrl?: string
  navigationToken: number
  pendingNavigationUrl?: string
}

export type BrowserShortcut =
  'focus-address' | 'new-tab' | 'close-tab' | 'reload' | 'back' | 'forward'

type NavigationRequestOptions = { popup?: boolean; newTab?: boolean }

export class TabManager {
  private readonly tabs = new Map<string, ManagedTab>()
  private readonly diagnostics = new Set<string>()
  private activeTabId = ''
  private nextId = 1

  constructor(
    private readonly window: BrowserWindow | Electron.BaseWindow,
    private readonly navigation: NavigationService,
    private readonly onChange: () => void,
    private readonly onVisit: (tab: BrowserTabState) => void,
    private readonly onShortcut: (shortcut: BrowserShortcut) => void,
    private readonly canNavigate: (
      url: string,
      options?: NavigationRequestOptions
    ) => boolean = () => true,
    private readonly canCreateTab: () => boolean = () => true,
    private readonly canNavigateHistory: (
      url: string,
      options?: NavigationRequestOptions
    ) => boolean = canNavigate,
    private readonly onActivity: (event: AssessmentActivityEvent) => void = () => {}
  ) {}

  createTab(input = NEW_TAB_URL): string {
    if (!this.canCreateTab()) throw new Error('New tabs are disabled during the assessment.')
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
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        navigationState: 'idle'
      },
      navigationToken: 0
    }
    this.tabs.set(id, tab)
    this.onActivity({ type: 'tab_created' })
    this.window.contentView.addChildView(view)
    this.attachEvents(tab)
    this.activateTab(id)
    if (input !== NEW_TAB_URL) {
      const url = this.navigation.normalize(input)
      tab.pendingNavigationUrl = url
      if (!this.canNavigate(url)) {
        this.onActivity({ type: 'navigation_blocked', url })
        this.setNavigationError(
          tab,
          url,
          -20,
          'Navigation was blocked by the active assessment policy.'
        )
        return id
      }
      this.onActivity({ type: 'navigation_started', url })
      void view.webContents.loadURL(url).catch((error: unknown) => {
        if (!this.isAlive(tab)) return
        if (tab.pendingNavigationUrl !== url) return
        this.setNavigationError(
          tab,
          url,
          -2,
          error instanceof Error ? error.message : 'Navigation failed'
        )
      })
    }
    return id
  }

  activateTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.activeTabId = id
    this.onActivity({ type: 'tab_switched' })
    for (const [tabId, tab] of this.tabs) {
      tab.view.setVisible(tabId === id)
    }
    this.syncNavigationHistory(tab)
    this.onChange()
  }

  private beginHistoryNavigation(tab: ManagedTab): void {
    tab.navigationToken += 1
    tab.pendingNavigationUrl = undefined
    tab.state.navigationState = 'recovering'
    tab.state.errorCode = undefined
    tab.state.errorMessage = undefined
    tab.state.failedUrl = undefined
    this.onChange()
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.window.contentView.removeChildView(tab.view)
    this.onActivity({ type: 'tab_closed' })
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
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
    const url = this.navigation.normalize(input)
    if (!this.canNavigate(url)) {
      this.onActivity({ type: 'navigation_blocked', url })
      tab.state.errorCode = -20
      tab.state.errorMessage = 'Navigation was blocked by the active assessment policy.'
      tab.state.failedUrl = url
      this.onChange()
      return
    }
    this.onActivity({ type: 'navigation_started', url })
    if (!this.navigation.isWebUrl(input)) {
      this.onActivity({ type: 'search_performed', query: input.slice(0, 256) })
    }
    tab.navigationToken += 1
    tab.pendingNavigationUrl = url
    tab.state.navigationState = 'recovering'
    tab.state.errorCode = undefined
    tab.state.errorMessage = undefined
    tab.state.failedUrl = undefined
    tab.pendingVisitUrl = undefined
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      if (!this.isAlive(tab)) return
      if (tab.pendingNavigationUrl !== url) return
      this.setNavigationError(
        tab,
        url,
        -2,
        error instanceof Error ? error.message : 'Navigation failed'
      )
    })
  }

  goBack(): void {
    const tab = this.activeTab
    const history = tab?.view.webContents.navigationHistory
    const target = history ? history.getEntryAtIndex(history.getActiveIndex() - 1) : null
    if (tab && history?.canGoBack() && target && this.canNavigateHistory(target.url)) {
      this.beginHistoryNavigation(tab)
      history.goBack()
    }
  }

  goForward(): void {
    const tab = this.activeTab
    const history = tab?.view.webContents.navigationHistory
    const target = history ? history.getEntryAtIndex(history.getActiveIndex() + 1) : null
    if (tab && history?.canGoForward() && target && this.canNavigateHistory(target.url)) {
      this.beginHistoryNavigation(tab)
      history.goForward()
    }
  }

  reload(): void {
    const tab = this.activeTab
    if (!tab) return
    tab.navigationToken += 1
    tab.pendingNavigationUrl = tab.state.url
    tab.state.navigationState = 'loading'
    tab.state.errorCode = undefined
    tab.state.errorMessage = undefined
    tab.state.failedUrl = undefined
    this.onChange()
    tab.view.webContents.reload()
  }

  stopLoading(): void {
    this.activeTab?.view.webContents.stop()
  }

  resize(width: number, height: number): void {
    const bounds = calculateBrowserLayout(width, height).webContent
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds)
    }
  }

  getState(): BrowserTabsState {
    return {
      tabs: [...this.tabs.values()].map(({ state }) => ({ ...state })),
      activeTabId: this.activeTabId
    }
  }

  destroy(): void {
    for (const tab of this.tabs.values()) {
      this.window.contentView.removeChildView(tab.view)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }

    this.tabs.clear()
  }

  bringViewsToFront(): void {
    for (const tab of this.tabs.values()) {
      this.window.contentView.removeChildView(tab.view)
      this.window.contentView.addChildView(tab.view)
    }
  }

  private get activeTab(): ManagedTab | undefined {
    return this.tabs.get(this.activeTabId)
  }

  private attachEvents(tab: ManagedTab): void {
    const { webContents } = tab.view
    const isCurrent = (): boolean => this.isAlive(tab)
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const modifier = input.control || input.meta
      const key = input.key.toLowerCase()
      const shortcut =
        modifier && key === 'l'
          ? 'focus-address'
          : modifier && key === 't'
            ? 'new-tab'
            : modifier && key === 'w'
              ? 'close-tab'
              : modifier && key === 'r'
                ? 'reload'
                : input.alt && key === 'arrowleft'
                  ? 'back'
                  : input.alt && key === 'arrowright'
                    ? 'forward'
                    : undefined
      if (shortcut) {
        event.preventDefault()
        this.onShortcut(shortcut)
      }
    })
    webContents.on('did-start-loading', () => {
      if (!isCurrent()) return
      tab.state.isLoading = true
      if (tab.state.navigationState !== 'recovering') tab.state.navigationState = 'loading'
      tab.state.errorCode = undefined
      tab.state.errorMessage = undefined
      tab.state.failedUrl = undefined
      this.onChange()
    })
    webContents.on('did-stop-loading', () => {
      if (!isCurrent()) return
      tab.state.isLoading = false
      this.syncState(tab)
      if (tab.pendingVisitUrl && tab.pendingVisitUrl === tab.state.url) {
        this.onVisit({ ...tab.state })
        tab.pendingVisitUrl = undefined
      }
    })
    webContents.on('page-title-updated', (event, title) => {
      if (!isCurrent()) return
      event.preventDefault()
      tab.state.title = title || 'New tab'
      this.onChange()
    })
    webContents.on('page-favicon-updated', (_event, favicons) => {
      if (!isCurrent()) return
      tab.state.favicon = favicons[0]
      this.onChange()
    })
    webContents.on('did-navigate', () => {
      if (!isCurrent()) return
      const actualUrl = tab.view.webContents.getURL()
      if (tab.pendingNavigationUrl && tab.pendingNavigationUrl !== actualUrl) {
        this.onActivity({ type: 'redirect_observed', url: actualUrl })
      }
      tab.pendingVisitUrl = tab.view.webContents.getURL()
      tab.state.errorCode = undefined
      tab.state.errorMessage = undefined
      tab.state.failedUrl = undefined
      tab.state.navigationState = 'loading'
      this.syncState(tab)
    })
    webContents.on('did-finish-load', () => {
      if (!isCurrent()) return
      tab.state.isLoading = false
      tab.state.navigationState = 'loaded'
      tab.state.errorCode = undefined
      tab.state.errorMessage = undefined
      tab.state.failedUrl = undefined
      tab.pendingNavigationUrl = undefined
      this.syncState(tab)
      this.onActivity({ type: 'navigation_completed', url: tab.state.url })
      const hostname = this.safeHostname(tab.state.url)
      if (hostname && isAssistanceDomain(hostname)) {
        this.onActivity({
          type: 'ai_assistance_domain_visited',
          hostname,
          url: tab.state.url
        })
      }
    })
    webContents.on('did-navigate-in-page', () => {
      if (isCurrent()) this.syncState(tab)
    })
    const handleMainFrameFailure = (
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || errorCode === -3 || !isCurrent()) return
      if (
        tab.pendingNavigationUrl &&
        validatedURL !== tab.pendingNavigationUrl &&
        tab.view.webContents.getURL() !== validatedURL
      ) {
        return
      }
      this.setNavigationError(tab, validatedURL, errorCode, errorDescription)
    }
    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
        handleMainFrameFailure(errorCode, errorDescription, validatedURL, isMainFrame)
    )
    webContents.on(
      'did-fail-provisional-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
        handleMainFrameFailure(errorCode, errorDescription, validatedURL, isMainFrame)
    )
    webContents.on('render-process-gone', () => {
      if (!isCurrent()) return
      this.setNavigationError(tab, tab.pendingNavigationUrl ?? tab.state.url, -1, '')
    })
    webContents.on('will-navigate', (event, url) => {
      if (!this.canNavigate(url)) {
        event.preventDefault()
        this.onActivity({ type: 'navigation_blocked', url })
        tab.state.errorCode = -20
        tab.state.errorMessage = 'Navigation was blocked by the active assessment policy.'
        tab.state.failedUrl = url
        tab.state.navigationState = 'failed'
        this.onChange()
        return
      }
      if (!this.navigation.isWebUrl(url)) {
        event.preventDefault()
        this.navigation.openExternal(url)
      }
    })
    webContents.setWindowOpenHandler(({ url }) => {
      if (!this.canNavigateHistory(url, { popup: true })) {
        this.onActivity({ type: 'popup_blocked', url })
        return { action: 'deny' }
      }
      this.onActivity({ type: 'popup_blocked', url })
      return { action: 'deny' }
    })
  }

  private syncState(tab: ManagedTab): void {
    if (!this.isAlive(tab)) return
    const previousUrl = tab.state.url
    tab.state.url = tab.view.webContents.getURL()
    this.syncNavigationHistory(tab)
    tab.state.isLoading = false
    if (tab.state.url !== previousUrl && !this.navigation.isWebUrl(tab.state.url))
      tab.pendingVisitUrl = undefined
    this.onChange()
  }

  private syncNavigationHistory(tab: ManagedTab): void {
    if (!this.isAlive(tab)) return
    const historyState = readNavigationHistory(tab.view.webContents.navigationHistory)
    tab.state.canGoBack = historyState.canGoBack
    tab.state.canGoForward = historyState.canGoForward
  }

  private isAlive(tab: ManagedTab): boolean {
    return this.tabs.get(tab.state.id) === tab && !tab.view.webContents.isDestroyed()
  }

  private setNavigationError(
    tab: ManagedTab,
    url: string,
    errorCode: number,
    description: string
  ): void {
    if (!this.isAlive(tab)) return
    tab.pendingVisitUrl = undefined
    tab.state.isLoading = false
    tab.state.errorCode = errorCode
    tab.state.errorMessage = describeNavigationError(errorCode, description)
    tab.state.failedUrl = url
    tab.state.url = url
    tab.state.title = 'Unable to load page'
    tab.state.navigationState = 'failed'
    tab.pendingNavigationUrl = undefined
    this.syncNavigationHistory(tab)
    const diagnosticKey = `${errorCode}:${url}`
    if (!this.diagnostics.has(diagnosticKey)) {
      this.diagnostics.add(diagnosticKey)
      console.warn(`Navigation failed (${errorCode}) for ${this.safeOrigin(url)}: ${description}`)
    }
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

  private safeOrigin(value: string): string {
    try {
      return new URL(value).origin
    } catch {
      return '[invalid-url]'
    }
  }

  private safeHostname(value: string): string | undefined {
    try {
      return new URL(value).hostname.toLowerCase()
    } catch {
      return undefined
    }
  }
}

function isAssistanceDomain(hostname: string): boolean {
  return (
    hostname === 'chatgpt.com' ||
    hostname.endsWith('.chatgpt.com') ||
    hostname === 'chat.openai.com' ||
    hostname.endsWith('.openai.com') ||
    hostname === 'claude.ai' ||
    hostname.endsWith('.claude.ai') ||
    hostname === 'anthropic.com' ||
    hostname.endsWith('.anthropic.com')
  )
}
