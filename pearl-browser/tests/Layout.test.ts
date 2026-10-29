import { describe, expect, it } from 'vitest'
import { calculateBrowserLayout, TOOLBAR_HEIGHT } from '../src/main/browser/Layout'

describe('browser layout', () => {
  it('places web content below the toolbar', () => {
    const layout = calculateBrowserLayout(1200, 800)
    expect(layout.chrome).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    expect(layout.webContent).toEqual({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: 1200,
      height: 800 - TOOLBAR_HEIGHT
    })
  })

  it('clamps small and invalid dimensions without negative bounds', () => {
    expect(calculateBrowserLayout(400, 100).webContent).toEqual({
      x: 0,
      y: 100,
      width: 400,
      height: 0
    })
    expect(calculateBrowserLayout(-10, -20)).toEqual({
      chrome: { x: 0, y: 0, width: 0, height: 0 },
      webContent: { x: 0, y: 0, width: 0, height: 0 }
    })
  })
})
