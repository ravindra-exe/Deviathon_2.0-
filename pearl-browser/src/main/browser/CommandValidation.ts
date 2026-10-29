import type { BrowserCommand, SearchEngine } from '../../shared/browser'
import { SEARCH_ENGINES } from './NavigationService'

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    return false
  }
  const command = value as Record<string, unknown>
  switch (command.type) {
    case 'create-tab':
      return command.url === undefined || isBoundedString(command.url, 2048)
    case 'activate-tab':
    case 'close-tab':
    case 'remove-bookmark':
    case 'remove-history':
    case 'cancel-download':
    case 'pause-download':
    case 'resume-download':
    case 'show-download-folder':
      return isBoundedString(
        command.tabId ?? command.bookmarkId ?? command.historyId ?? command.downloadId,
        128
      )
    case 'navigate':
    case 'navigate-to-url':
      return isBoundedString(command.input ?? command.url, 2048)
    case 'set-history-enabled':
    case 'set-restore-session':
      return typeof command.enabled === 'boolean'
    case 'set-panel-open':
      return typeof command.open === 'boolean'
    case 'set-search-engine':
      return typeof command.engineId === 'string' && isSearchEngine(command.engineId)
    case 'go-back':
    case 'go-forward':
    case 'reload':
    case 'stop-loading':
    case 'add-bookmark':
    case 'clear-history':
      return true
    default:
      return false
  }
}

function isSearchEngine(value: string): value is SearchEngine['id'] {
  return SEARCH_ENGINES.some((engine) => engine.id === value)
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}
