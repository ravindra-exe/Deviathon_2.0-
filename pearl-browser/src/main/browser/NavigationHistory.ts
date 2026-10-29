export interface NavigationHistoryState {
  canGoBack: boolean
  canGoForward: boolean
}

export interface NavigationHistoryReader {
  canGoBack(): boolean
  canGoForward(): boolean
}

export function readNavigationHistory(history: NavigationHistoryReader): NavigationHistoryState {
  return {
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  }
}
