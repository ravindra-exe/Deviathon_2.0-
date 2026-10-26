import { describe, expect, it } from 'vitest'
import { NavigationService } from '../src/main/browser/NavigationService'

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

  it('ignores an invalid search-engine selection', () => {
    const navigation = new NavigationService('bing')
    navigation.setSearchEngine('invalid' as never)
    expect(navigation.searchEngineId).toBe('bing')
  })
})
