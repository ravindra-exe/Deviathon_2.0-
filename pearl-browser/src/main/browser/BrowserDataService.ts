import type { BrowserTabState, HistoryEntry } from '../../shared/browser'
import { NavigationService } from './NavigationService'
import { PersistenceService } from './PersistenceService'

export class BrowserDataService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly navigation: NavigationService
  ) {}

  addBookmark(tab: BrowserTabState): void {
    if (!this.navigation.isWebUrl(tab.url)) return
    if (this.persistence.snapshot.bookmarks.some((bookmark) => bookmark.url === tab.url)) return
    this.persistence.update((data) => {
      data.bookmarks.unshift({
        id: `bookmark-${Date.now()}`,
        url: tab.url,
        title: tab.title || tab.url,
        favicon: tab.favicon,
        createdAt: new Date().toISOString()
      })
    })
  }

  removeBookmark(id: string): void {
    this.persistence.update((data) => {
      data.bookmarks = data.bookmarks.filter((bookmark) => bookmark.id !== id)
    })
  }

  recordVisit(tab: BrowserTabState): void {
    if (!this.persistence.snapshot.preferences.historyEnabled || !this.navigation.isWebUrl(tab.url))
      return
    this.persistence.update((data) => {
      const last = data.history[0]
      if (last?.url === tab.url && Date.now() - Date.parse(last.visitedAt) < 1000) return
      data.history.unshift({
        id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url: tab.url,
        title: tab.title || tab.url,
        visitedAt: new Date().toISOString()
      })
      data.history = data.history.slice(0, 5000)
    })
  }

  searchHistory(query: string): HistoryEntry[] {
    const normalized = query.trim().toLowerCase()
    return this.persistence.snapshot.history.filter(
      (entry) =>
        !normalized ||
        entry.title.toLowerCase().includes(normalized) ||
        entry.url.toLowerCase().includes(normalized)
    )
  }

  removeHistory(id: string): void {
    this.persistence.update((data) => {
      data.history = data.history.filter((entry) => entry.id !== id)
    })
  }

  clearHistory(): void {
    this.persistence.update((data) => {
      data.history = []
    })
  }
}
