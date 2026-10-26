import { shell } from 'electron'
import type { SearchEngine } from '../../shared/browser'

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'google', label: 'Google', searchUrl: 'https://www.google.com/search?q=' },
  { id: 'bing', label: 'Bing', searchUrl: 'https://www.bing.com/search?q=' },
  { id: 'duckduckgo', label: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=' }
]

export class NavigationService {
  constructor(private searchEngine: SearchEngine['id'] = 'google') {}

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

    return `${this.searchEngineDefinition.searchUrl}${encodeURIComponent(value)}`
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
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
        void shell.openExternal(value)
      } else {
        console.warn('Blocked unsupported external protocol:', url.protocol)
      }
    } catch {
      console.warn('Blocked malformed external URL:', value)
    }
  }

  get searchEngineUrl(): string {
    return this.searchEngineDefinition.searchUrl
  }

  get searchEngineId(): SearchEngine['id'] {
    return this.searchEngine
  }

  setSearchEngine(engine: SearchEngine['id']): void {
    if (SEARCH_ENGINES.some((candidate) => candidate.id === engine)) this.searchEngine = engine
  }

  private get searchEngineDefinition(): SearchEngine {
    return SEARCH_ENGINES.find((engine) => engine.id === this.searchEngine) ?? SEARCH_ENGINES[0]
  }
}
