import { useEffect, useMemo, useState } from 'react'
import type { BrowserCommand, BrowserState } from '../../shared/browser'
import { BrowserPanels } from './components/BrowserPanels'
import { NavigationToolbar } from './components/NavigationToolbar'
import { TabStrip } from './components/TabStrip'

const initialState: BrowserState = {
  tabs: [],
  activeTabId: '',
  searchEngineUrl: 'https://www.google.com/search?q=',
  bookmarks: [],
  history: [],
  downloads: [],
  preferences: {
    searchEngineId: 'google',
    historyEnabled: true,
    restoreSession: false
  }
}

function App(): React.JSX.Element {
  const [state, setState] = useState(initialState)
  const [panel, setPanel] = useState<'bookmarks' | 'history' | 'downloads' | 'settings' | null>(
    null
  )
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId), [state])
  const isBookmarked = Boolean(
    activeTab && state.bookmarks.some((bookmark) => bookmark.url === activeTab.url)
  )

  useEffect(() => {
    let mounted = true
    void window.browser.getState().then((next) => {
      if (mounted) setState(next)
    })
    const unsubscribe = window.browser.onStateChange(setState)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const command = (next: BrowserCommand): void => {
    void window.browser
      .command(next)
      .then(setState)
      .catch((error: unknown) => console.error(error))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('input[name="address"]')?.select()
      } else if (modifier && event.key.toLowerCase() === 't') {
        event.preventDefault()
        command({ type: 'create-tab' })
      } else if (modifier && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (activeTab) command({ type: 'close-tab', tabId: activeTab.id })
      } else if (modifier && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        command({ type: 'reload' })
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        command({ type: 'go-back' })
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        command({ type: 'go-forward' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <main className="browser-chrome">
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(tabId) => command({ type: 'activate-tab', tabId })}
        onClose={(tabId) => command({ type: 'close-tab', tabId })}
        onNew={() => command({ type: 'create-tab' })}
      />
      <NavigationToolbar
        activeTab={activeTab}
        isBookmarked={isBookmarked}
        onCommand={(type) => command({ type })}
        onNavigate={(input) => command({ type: 'navigate', input })}
        onBookmark={() => {
          if (!isBookmarked) command({ type: 'add-bookmark' })
        }}
        onPanel={setPanel}
      />
      <BrowserPanels
        panel={panel}
        state={state}
        onCommand={command}
        onClose={() => setPanel(null)}
      />
    </main>
  )
}

export default App
