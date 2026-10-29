import { describe, expect, it } from 'vitest'
import { readNavigationHistory } from '../src/main/browser/NavigationHistory'

describe('readNavigationHistory', () => {
  it('disables both controls for the first page', () => {
    expect(
      readNavigationHistory({
        canGoBack: () => false,
        canGoForward: () => false
      })
    ).toEqual({ canGoBack: false, canGoForward: false })
  })

  it('enables back when a tab has a previous entry', () => {
    expect(
      readNavigationHistory({
        canGoBack: () => true,
        canGoForward: () => false
      })
    ).toEqual({ canGoBack: true, canGoForward: false })
  })

  it('enables forward after going back', () => {
    expect(
      readNavigationHistory({
        canGoBack: () => true,
        canGoForward: () => true
      })
    ).toEqual({ canGoBack: true, canGoForward: true })
  })

  it('keeps histories independent when tabs switch', () => {
    const firstTab = readNavigationHistory({
      canGoBack: () => true,
      canGoForward: () => false
    })
    const secondTab = readNavigationHistory({
      canGoBack: () => false,
      canGoForward: () => true
    })

    expect(firstTab).toEqual({ canGoBack: true, canGoForward: false })
    expect(secondTab).toEqual({ canGoBack: false, canGoForward: true })
  })
})
