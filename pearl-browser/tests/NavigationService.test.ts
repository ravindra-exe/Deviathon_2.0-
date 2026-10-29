import { describe, expect, it } from 'vitest'
import { describeNavigationError, NavigationService } from '../src/main/browser/NavigationService'

describe('NavigationService', () => {
  it('normalizes direct HTTP(S) URLs and searches ordinary text', () => {
    const navigation = new NavigationService()
    expect(navigation.normalize('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1'
    )
    expect(navigation.normalize('example.com')).toBe('https://example.com/')
    expect(navigation.normalize('Pearl Browser & tests')).toBe(
      'https://www.google.com/search?q=Pearl%20Browser%20%26%20tests'
    )
  })

  it.each([
    ['google', 'https://www.google.com/search?q=hello%20world'],
    ['bing', 'https://www.bing.com/search?q=hello%20world'],
    ['duckduckgo', 'https://duckduckgo.com/?q=hello%20world']
  ] as const)('uses the allowlisted %s search engine', (engine, expected) => {
    const navigation = new NavigationService(engine)
    expect(navigation.normalize('hello world')).toBe(expected)
  })

  it('does not treat unsupported protocols as ordinary web URLs', () => {
    const navigation = new NavigationService()
    expect(navigation.isWebUrl('file:///private')).toBe(false)
    expect(navigation.isWebUrl('javascript:alert(1)')).toBe(false)
    expect(navigation.normalize('file:///private')).toContain('google.com/search?q=')
  })

  it.each(['localhost:3000/app', '127.0.0.1:8080/health', '192.168.1.10'])(
    'accepts local host input %s',
    (input) => {
      expect(new NavigationService().normalize(input)).toBe(new URL(`https://${input}`).toString())
    }
  )

  it('searches a single word instead of treating it as a hostname', () => {
    expect(new NavigationService().normalize('youtube')).toBe(
      'https://www.google.com/search?q=youtube'
    )
  })

  it('ignores an invalid search-engine selection', () => {
    const navigation = new NavigationService('bing')
    navigation.setSearchEngine('invalid' as never)
    expect(navigation.searchEngineId).toBe('bing')
  })

  it('classifies DNS and certificate failures without weakening security', () => {
    expect(describeNavigationError(-105, 'ERR_NAME_NOT_RESOLVED')).toContain(
      'hostname could not be resolved'
    )
    expect(describeNavigationError(-202, 'ERR_CERT_AUTHORITY_INVALID')).toContain(
      'trusted HTTPS connection'
    )
  })

  it.each([
    [-106, 'ERR_INTERNET_DISCONNECTED', 'offline'],
    [-102, 'ERR_CONNECTION_REFUSED', 'server did not respond'],
    [-118, 'ERR_CONNECTION_TIMED_OUT', 'server did not respond']
  ])('classifies network failure %s', (code, description, expected) => {
    expect(describeNavigationError(code, description)).toContain(expected)
  })
})
