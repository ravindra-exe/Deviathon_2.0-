import { useEffect, useMemo, useState } from 'react'
import type { BrowserCommand, BrowserState } from '../../shared/browser'
import { BrowserPanels } from './components/BrowserPanels'
import { NavigationToolbar } from './components/NavigationToolbar'
import { TabStrip } from './components/TabStrip'
import { AssessmentExperience } from './components/AssessmentExperience'

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

const quickLinks = [
  { label: 'Google', url: 'https://www.google.com' },
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'Gmail', url: 'https://mail.google.com' }
]

interface NewTabPageProps {
  bookmarks: BrowserState['bookmarks']
  onNavigate: (input: string) => void
  onBookmarkNavigate: (url: string) => void
}

function NewTabPage({
  bookmarks,
  onNavigate,
  onBookmarkNavigate
}: NewTabPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  return (
    <section className="new-tab-content">
      <div className="new-tab-layout">
        <div className="new-tab-hero">
          <div className="new-tab-brand">
            <span className="new-tab-brand-orbit" aria-hidden="true">
              <span className="new-tab-brand-core" />
            </span>
            <span className="new-tab-mark">
              <strong>PEARL</strong>
              <span>BROWSER</span>
            </span>
          </div>
          <h1>A calmer way to browse.</h1>
          <p>Search the web, keep your essentials close, and move with intention.</p>
          <form
            className="new-tab-search"
            onSubmit={(event) => {
              event.preventDefault()
              const value = query.trim()
              if (value) {
                setQuery('')
                onNavigate(value)
              }
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the web or enter an address"
              aria-label="New tab search"
            />
            <button className="go-button" type="submit">
              Go
            </button>
          </form>
        </div>
        <div className="quick-access" aria-label="Quick access">
          <div className="section-label">Quick access</div>
          <div className="quick-links">
            {quickLinks.map((link) => (
              <button className="quick-link" key={link.url} onClick={() => onNavigate(link.url)}>
                <span className="quick-link-icon" aria-hidden="true">
                  {link.label.slice(0, 1)}
                </span>
                <span>{link.label}</span>
              </button>
            ))}
          </div>
        </div>
        {bookmarks.length > 0 && (
          <div className="new-tab-recents">
            <div className="section-label">Saved by you</div>
            <div className="saved-links">
              {bookmarks.slice(0, 3).map((bookmark) => (
                <button
                  className="saved-link"
                  key={bookmark.id}
                  onClick={() => onBookmarkNavigate(bookmark.url)}
                >
                  <strong>{bookmark.title}</strong>
                  <small>{bookmark.url}</small>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function App(): React.JSX.Element {
  const [state, setState] = useState(initialState)
  const [panel, setPanel] = useState<'bookmarks' | 'history' | 'downloads' | 'settings' | null>(
    null
  )
  const [assessmentMode, setAssessmentMode] = useState(false)
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId), [state])
  const isBookmarked = Boolean(
    activeTab && state.bookmarks.some((bookmark) => bookmark.url === activeTab.url)
  )
  const isNewTab = activeTab?.url === 'about:blank'

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

  useEffect(() => {
    let mounted = true
    void window.browser.assessment.getState().then((assessmentSession) => {
      if (mounted && assessmentSession.status !== 'idle') setAssessmentMode(true)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    return window.browser.onFocusAddress(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="address"]')
      input?.focus()
      input?.select()
    })
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
        const input = document.querySelector<HTMLInputElement>('input[name="address"]')
        input?.focus()
        input?.select()
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

  return assessmentMode ? (
    <AssessmentExperience
      browserState={state}
      onBrowserCommand={command}
      onExit={() => {
        void window.browser.assessment.cancel().finally(() => {
          setAssessmentMode(false)
          command({ type: 'set-panel-open', open: false })
        })
      }}
    />
  ) : (
    <main className="browser-chrome">
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(tabId) => command({ type: 'activate-tab', tabId })}
        onClose={(tabId) => command({ type: 'close-tab', tabId })}
        onNew={() => command({ type: 'create-tab' })}
      />
      <NavigationToolbar
        key={`${activeTab?.id ?? 'none'}:${activeTab?.url ?? ''}`}
        activeTab={activeTab}
        isBookmarked={isBookmarked}
        onCommand={(type) => command({ type })}
        onNavigate={(input) => command({ type: 'navigate', input })}
        onBookmark={() => {
          if (!isBookmarked) command({ type: 'add-bookmark' })
        }}
        onPanel={(nextPanel) => {
          setPanel(nextPanel)
          command({ type: 'set-panel-open', open: true })
        }}
        onAssessment={() => {
          setAssessmentMode(true)
          command({ type: 'set-panel-open', open: true })
        }}
      />
      {activeTab?.errorMessage && (
        <section className="navigation-error" role="alert">
          <div className="navigation-error-content">
            <span className="navigation-error-icon" aria-hidden="true">
              !
            </span>
            <div>
              <strong>
                {activeTab.errorCode === -202
                  ? 'Secure connection failed'
                  : activeTab.errorCode === -1
                    ? 'Page renderer stopped'
                    : 'Page could not be loaded'}
              </strong>
              <p>{activeTab.errorMessage}</p>
            </div>
          </div>
          <div className="navigation-error-actions">
            <button
              className="go-button"
              title="Retry navigation"
              onClick={() =>
                activeTab.failedUrl && command({ type: 'navigate', input: activeTab.failedUrl })
              }
            >
              Retry
            </button>
            <button
              className="secondary-button"
              title="Open a new tab"
              onClick={() => command({ type: 'create-tab' })}
            >
              New tab
            </button>
          </div>
        </section>
      )}
      {isNewTab && (
        <NewTabPage
          bookmarks={state.bookmarks}
          onNavigate={(input) => command({ type: 'navigate', input })}
          onBookmarkNavigate={(url) => command({ type: 'navigate-to-url', url })}
        />
      )}
      <BrowserPanels
        panel={panel}
        state={state}
        onCommand={command}
        onClose={() => {
          setPanel(null)
          command({ type: 'set-panel-open', open: false })
        }}
      />
    </main>
  )
}

export default App
