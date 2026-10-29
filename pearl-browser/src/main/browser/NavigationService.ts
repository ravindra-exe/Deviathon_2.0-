import { shell } from 'electron'
import type { SearchEngine } from '../../shared/browser'

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'google', label: 'Google', searchUrl: 'https://www.google.com/search?q=' },
  { id: 'bing', label: 'Bing', searchUrl: 'https://www.bing.com/search?q=' },
  { id: 'duckduckgo', label: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=' }
]

const COMMON_DOMAIN_SUFFIXES = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'io',
  'co',
  'app',
  'dev',
  'ai',
  'me',
  'tv',
  'uk',
  'de',
  'fr',
  'in',
  'ca',
  'au',
  'xyz'
])

export function describeNavigationError(errorCode: number, description: string): string {
  const normalized = description.toUpperCase()
  if (errorCode === -105 || normalized.includes('NAME_NOT_RESOLVED')) {
    return 'The hostname could not be resolved. Check the address or your network connection.'
  }
  if (
    errorCode === -202 ||
    normalized.includes('CERT_AUTHORITY_INVALID') ||
    normalized.includes('CERT_DATE_INVALID') ||
    normalized.includes('CERT_')
  ) {
    return 'Pearl Browser could not establish a trusted HTTPS connection. Certificate verification was not bypassed.'
  }
  if (errorCode === -106 || normalized.includes('INTERNET_DISCONNECTED')) {
    return 'The device appears to be offline. Check the network connection and try again.'
  }
  if (
    errorCode === -102 ||
    errorCode === -118 ||
    errorCode === -7 ||
    normalized.includes('CONNECTION_REFUSED') ||
    normalized.includes('TIMED_OUT')
  ) {
    return 'The server did not respond. Check the address or try again later.'
  }
  return `Pearl Browser could not load this page. ${description || 'Try again.'}`
}

export class NavigationService {
  constructor(private searchEngine: SearchEngine['id'] = 'google') {}

  normalize(input: string): string {
    const value = input.trim()
    if (!value) {
      return 'https://www.google.com'
    }

    if (this.isExplicitWebUrl(value) || this.isLikelyHostname(value)) {
      try {
        const url = new URL(this.isExplicitWebUrl(value) ? value : `https://${value}`)
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
      } catch {
        // Treat malformed input as a search query.
      }
    }

    return `${this.searchEngineDefinition.searchUrl}${encodeURIComponent(value)}`
  }

  private isExplicitWebUrl(value: string): boolean {
    return /^https?:\/\//i.test(value)
  }

  private isLikelyHostname(value: string): boolean {
    const withoutPath = value.split(/[/?#]/, 1)[0]
    if (/^localhost(?::\d+)?$/i.test(withoutPath)) return true
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(withoutPath)) {
      return withoutPath
        .split(':')[0]
        .split('.')
        .every((part) => Number(part) <= 255)
    }
    const labels = withoutPath.split('.')
    return (
      labels.length >= 2 &&
      labels.every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)) &&
      COMMON_DOMAIN_SUFFIXES.has(labels.at(-1)?.toLowerCase() ?? '')
    )
  }

  isWebUrl(value: string): boolean {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  isSearchQuery(value: string): boolean {
    const input = value.trim()
    return Boolean(input) && !this.isExplicitWebUrl(input) && !this.isLikelyHostname(input)
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
