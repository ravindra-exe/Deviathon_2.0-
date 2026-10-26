import { app, ipcMain, session, WebContentsView, BaseWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { BrowserCommand } from '../shared/browser'
import { NavigationService } from './browser/NavigationService'
import { TabManager } from './browser/TabManager'

let mainWindow: BaseWindow | undefined
let chromeView: WebContentsView | undefined
let tabs: TabManager | undefined

function isChromeSender(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === chromeView?.webContents
}

function createWindow(): void {
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

  const navigation = new NavigationService()
  tabs = new TabManager(mainWindow, navigation, () => {
    if (chromeView && !chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send('browser-state', tabs?.getState())
    }
  })

  const updateBounds = (): void => {
    if (!mainWindow || !chromeView) return
    const [width, height] = mainWindow.getContentSize()
    chromeView.setBounds({ x: 0, y: 0, width, height: 118 })
    tabs?.resize(width, height)
  }
  mainWindow.on('resize', updateBounds)
  mainWindow.on('closed', () => {
    tabs?.destroy()
    tabs = undefined
    chromeView = undefined
    mainWindow = undefined
  })

  chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  chromeView.webContents.on('did-finish-load', () => {
    tabs?.createTab()
    updateBounds()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void chromeView.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('browser:get-state', (event) => {
  if (!isChromeSender(event) || !tabs) throw new Error('Unauthorized browser state request')
  return tabs.getState()
})

ipcMain.handle('browser:command', (event, command: BrowserCommand) => {
  if (!isChromeSender(event) || !tabs || !command || typeof command.type !== 'string') {
    throw new Error('Unauthorized or invalid browser command')
  }
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
      if (typeof command.input !== 'string' || command.input.length > 2048)
        throw new Error('Invalid navigation input')
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
  }
  return tabs.getState()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.pearl.browser')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
