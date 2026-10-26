import { shell } from 'electron'

const SEARCH_ENGINE_URL = 'https://www.google.com/search?q='

export class NavigationService {
  normalize(input: string): string {
    const value = input.trim()
    if (!value) {
      return 'https://www.google.com'
    }

    try {
      const withProtocol = /^[a-z][a-z\d+\-.]*:/i.test(value) ? value : `https://${value}`
      const url = new URL(withProtocol)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString()
      }
    } catch {
      // Treat malformed input as a search query.
    }

    return `${SEARCH_ENGINE_URL}${encodeURIComponent(value)}`
  }

  isWebUrl(value: string): boolean {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  openExternal(value: string): void {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        void shell.openExternal(value)
      }
    } catch {
      console.warn('Blocked malformed external URL:', value)
    }
  }

  get searchEngineUrl(): string {
    return SEARCH_ENGINE_URL
  }
}
