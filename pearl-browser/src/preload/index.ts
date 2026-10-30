import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserAPI, BrowserCommand, BrowserState } from '../shared/browser'
import type { AssessmentAPI, AssessmentActivityEvent } from '../shared/assessment'
import type { AdminConsoleAPI } from '../shared/admin'

const assessment: AssessmentAPI = {
  getState: () => ipcRenderer.invoke('assessment:get-state'),
  start: (mode) => ipcRenderer.invoke('assessment:start', mode),
  authenticate: (displayName, demoCode) =>
    ipcRenderer.invoke('assessment:authenticate', displayName, demoCode),
  requestOtp: (email) => ipcRenderer.invoke('assessment:request-otp', email),
  begin: () => ipcRenderer.invoke('assessment:begin'),
  answer: (questionId, optionIndex) =>
    ipcRenderer.invoke('assessment:answer', questionId, optionIndex),
  goToQuestion: (index) => ipcRenderer.invoke('assessment:go-to-question', index),
  submit: () => ipcRenderer.invoke('assessment:submit'),
  cancel: () => ipcRenderer.invoke('assessment:cancel'),
  recordActivityEvent: (event: AssessmentActivityEvent) =>
    ipcRenderer.invoke('assessment:record-activity', event),
  setCameraConsent: (consented: boolean) =>
    ipcRenderer.invoke('assessment:set-camera-consent', consented),
  setCameraReadiness: (ready: boolean) =>
    ipcRenderer.invoke('assessment:set-camera-readiness', ready),
  acknowledgePolicy: (acknowledged) =>
    ipcRenderer.invoke('assessment:acknowledge-policy', acknowledged),
  getProctoringInsights: () => ipcRenderer.invoke('assessment:get-proctoring-insights'),
  onStateChange: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0]
    ): void => listener(state)
    ipcRenderer.on('assessment-state', handler)
    return () => ipcRenderer.removeListener('assessment-state', handler)
  }
}

const browser: BrowserAPI = {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  command: (command: BrowserCommand) => ipcRenderer.invoke('browser:command', command),
  onStateChange: (listener: (state: BrowserState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserState): void =>
      listener(state)
    ipcRenderer.on('browser-state', handler)
    return () => ipcRenderer.removeListener('browser-state', handler)
  },
  onFocusAddress: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('browser-focus-address', handler)
    return () => ipcRenderer.removeListener('browser-focus-address', handler)
  },
  assessment,
  admin: {
    open: () => ipcRenderer.invoke('admin:open'),
    close: () => ipcRenderer.invoke('admin:close'),
    requestOtp: (email) => ipcRenderer.invoke('admin:request-otp', email),
    verifyOtp: (email, code) => ipcRenderer.invoke('admin:verify-otp', email, code),
    resume: () => ipcRenderer.invoke('admin:resume'),
    getData: () => ipcRenderer.invoke('admin:get-data'),
    generateQuestions: (request) => ipcRenderer.invoke('admin:generate-questions', request),
    saveAssessmentDraft: (draft) => ipcRenderer.invoke('admin:save-assessment-draft', draft),
    publishAssessment: (assessmentId) =>
      ipcRenderer.invoke('admin:publish-assessment', assessmentId),
    getInsights: (attemptId, assessmentId) =>
      ipcRenderer.invoke('admin:get-insights', attemptId, assessmentId),
    recordExport: (targetId) => ipcRenderer.invoke('admin:record-export', targetId),
    logout: () => ipcRenderer.invoke('admin:logout')
  } satisfies AdminConsoleAPI
}

if (process.contextIsolated) contextBridge.exposeInMainWorld('browser', browser)
