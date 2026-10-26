import { app, BaseWindow, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { BrowserCommand, BrowserState } from '../shared/browser'
import { isBrowserCommand } from './browser/CommandValidation'
import { DownloadManager } from './browser/DownloadManager'
import { BrowserDataService } from './browser/BrowserDataService'
import { NavigationService } from './browser/NavigationService'
import { PersistenceService } from './browser/PersistenceService'
import { TabManager } from './browser/TabManager'

let mainWindow: BaseWindow | undefined
let chromeView: WebContentsView | undefined
let tabs: TabManager | undefined
let persistence: PersistenceService | undefined
let downloads: DownloadManager | undefined
let navigation: NavigationService | undefined
let browserData: BrowserDataService | undefined

function isChromeSender(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === chromeView?.webContents
}

function createWindow(): void {
  if (!persistence) throw new Error('Persistence is not initialized')
  const saved = persistence.snapshot
  navigation = new NavigationService(saved.preferences.searchEngineId)
  browserData = new BrowserDataService(persistence, navigation)
  mainWindow = new BaseWindow({ width: 1200, height: 800, autoHideMenuBar: true })
  chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow.contentView.addChildView(chromeView)
  chromeView.setBackgroundColor('#00000000')

  const emitChange = (): void => {
    if (persistence?.snapshot.preferences.restoreSession && tabs) {
      persistence?.update((data) => {
        data.session = tabs?.getRestorableSession() ?? { urls: [] }
      })
    }
    if (mainWindow && chromeView) mainWindow.contentView.addChildView(chromeView)
    if (chromeView && !chromeView.webContents.isDestroyed())
      chromeView.webContents.send('browser-state', getState())
  }
  tabs = new TabManager(mainWindow, navigation, emitChange, (tab) => {
    browserData?.recordVisit(tab)
  })
  downloads = new DownloadManager(mainWindow, persistence, emitChange)

  const updateBounds = (): void => {
    if (!mainWindow || !chromeView) return
    const [width, height] = mainWindow.getContentSize()
    chromeView.setBounds({ x: 0, y: 0, width, height })
    tabs?.resize(width, height)
  }
  mainWindow.on('resize', updateBounds)
  mainWindow.on('closed', () => {
    if (persistence && tabs && persistence.snapshot.preferences.restoreSession) {
      persistence.update((data) => {
        data.session = tabs?.getRestorableSession() ?? { urls: [] }
      })
    }
    tabs?.destroy()
    downloads?.dispose()
    tabs = undefined
    downloads = undefined
    chromeView = undefined
    mainWindow = undefined
  })

  chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  chromeView.webContents.on('did-finish-load', () => {
    const urls = saved.preferences.restoreSession ? saved.session.urls : []
    if (urls.length > 0) {
      for (const url of urls) tabs?.createTab(url)
      const activeIndex = saved.session.activeUrl ? urls.indexOf(saved.session.activeUrl) : 0
      const activeTab = tabs?.getState().tabs[Math.max(0, activeIndex)]
      if (activeTab) tabs?.activateTab(activeTab.id)
    } else {
      tabs?.createTab()
    }
    updateBounds()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void chromeView.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getState(): BrowserState {
  if (!persistence || !tabs || !navigation || !downloads) throw new Error('Browser is not ready')
  const saved = persistence.snapshot
  return {
    tabs: tabs.getState().tabs,
    activeTabId: tabs.getState().activeTabId,
    searchEngineUrl: navigation.searchEngineUrl,
    bookmarks: saved.bookmarks,
    history: saved.history,
    downloads: downloads.getState(),
    preferences: saved.preferences
  }
}

ipcMain.handle('browser:get-state', (event) => {
  if (!isChromeSender(event)) throw new Error('Unauthorized browser state request')
  return getState()
})

ipcMain.handle('browser:command', (event, command: BrowserCommand) => {
  if (
    !isChromeSender(event) ||
    !tabs ||
    !persistence ||
    !navigation ||
    !downloads ||
    !isBrowserCommand(command)
  ) {
    throw new Error('Unauthorized or invalid browser command')
  }
  const active = tabs.getState().tabs.find((tab) => tab.id === tabs?.getState().activeTabId)
  switch (command.type) {
    case 'create-tab':
      tabs.createTab(command.url)
      break
    case 'activate-tab':
      tabs.activateTab(command.tabId)
      break
    case 'close-tab':
      tabs.closeTab(command.tabId)
      break
    case 'navigate':
      tabs.navigate(command.input)
      break
    case 'go-back':
      tabs.goBack()
      break
    case 'go-forward':
      tabs.goForward()
      break
    case 'reload':
      tabs.reload()
      break
    case 'stop-loading':
      tabs.stopLoading()
      break
    case 'add-bookmark':
      if (active) browserData?.addBookmark(active)
      break
    case 'remove-bookmark':
      browserData?.removeBookmark(command.bookmarkId)
      break
    case 'navigate-to-url':
      if (!navigation.isWebUrl(command.url)) throw new Error('Invalid bookmark or history URL')
      tabs.navigate(command.url)
      break
    case 'remove-history':
      browserData?.removeHistory(command.historyId)
      break
    case 'clear-history':
      browserData?.clearHistory()
      break
    case 'set-history-enabled':
      persistence.update((data) => {
        data.preferences.historyEnabled = command.enabled
      })
      break
    case 'set-search-engine':
      navigation.setSearchEngine(command.engineId)
      persistence.update((data) => {
        data.preferences.searchEngineId = command.engineId
      })
      break
    case 'set-restore-session':
      persistence.update((data) => {
        data.preferences.restoreSession = command.enabled
        if (!command.enabled) data.session = { urls: [] }
      })
      break
    case 'cancel-download':
      downloads.cancel(command.downloadId)
      break
    case 'pause-download':
      downloads.pause(command.downloadId)
      break
    case 'resume-download':
      downloads.resume(command.downloadId)
      break
    case 'show-download-folder':
      downloads.showFolder(command.downloadId)
      break
  }
  return getState()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.pearl.browser')
  persistence = new PersistenceService()
  if (
    persistence.snapshot.preferences.restoreSession === false &&
    persistence.snapshot.session.urls.length > 0
  ) {
    persistence.update((data) => {
      data.session = { urls: [] }
    })
  }
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
