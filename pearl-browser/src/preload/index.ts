import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserAPI, BrowserCommand, BrowserState } from '../shared/browser'

const browser: BrowserAPI = {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  command: (command: BrowserCommand) => ipcRenderer.invoke('browser:command', command),
  onStateChange: (listener: (state: BrowserState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserState): void =>
      listener(state)
    ipcRenderer.on('browser-state', handler)
    return () => ipcRenderer.removeListener('browser-state', handler)
  }
}

if (process.contextIsolated) contextBridge.exposeInMainWorld('browser', browser)
