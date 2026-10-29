export const TOOLBAR_HEIGHT = 112

export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserLayout {
  chrome: ViewBounds
  webContent: ViewBounds
}

export function calculateBrowserLayout(width: number, height: number): BrowserLayout {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeHeight = Math.max(0, Math.floor(height))
  return {
    chrome: { x: 0, y: 0, width: safeWidth, height: safeHeight },
    webContent: {
      x: 0,
      y: Math.min(TOOLBAR_HEIGHT, safeHeight),
      width: safeWidth,
      height: Math.max(0, safeHeight - TOOLBAR_HEIGHT)
    }
  }
}
