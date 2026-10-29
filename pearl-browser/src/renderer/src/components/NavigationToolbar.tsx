import { useState } from 'react'
import type { BrowserTabState } from '../../../shared/browser'

interface NavigationToolbarProps {
  activeTab?: BrowserTabState
  isBookmarked: boolean
  onCommand: (type: 'go-back' | 'go-forward' | 'reload' | 'stop-loading') => void
  onNavigate: (value: string) => void
  onBookmark: () => void
  onPanel: (panel: 'bookmarks' | 'history' | 'downloads' | 'settings') => void
  onAssessment: () => void
}

export function NavigationToolbar({
  activeTab,
  isBookmarked,
  onCommand,
  onNavigate,
  onBookmark,
  onPanel,
  onAssessment
}: NavigationToolbarProps): React.JSX.Element {
  const [address, setAddress] = useState(
    activeTab?.url === 'about:blank' ? '' : (activeTab?.url ?? '')
  )

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onNavigate(address)
  }
  return (
    <div className="navigation-toolbar">
      <div className="navigation-actions">
        <button
          className="icon-button"
          disabled={!activeTab?.canGoBack}
          onClick={() => onCommand('go-back')}
          aria-label="Back"
          title="Back"
        >
          ←
        </button>
        <button
          className="icon-button"
          disabled={!activeTab?.canGoForward}
          onClick={() => onCommand('go-forward')}
          aria-label="Forward"
          title="Forward"
        >
          →
        </button>
        <button
          className="icon-button"
          onClick={() => onCommand(activeTab?.isLoading ? 'stop-loading' : 'reload')}
          aria-label={activeTab?.isLoading ? 'Stop loading' : 'Reload'}
          title={activeTab?.isLoading ? 'Stop loading' : 'Reload'}
        >
          {activeTab?.isLoading ? '■' : '↻'}
        </button>
      </div>
      <form className="address-form" onSubmit={submit}>
        <span className="secure-mark" aria-hidden="true">
          ◈
        </span>
        <input
          name="address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Address and search"
        />
        <button className="go-button" type="submit" title="Go to address or search">
          Go
        </button>
      </form>
      {activeTab?.isLoading && <div className="loading-progress" aria-label="Page loading" />}
      <button
        className={`toolbar-button ${isBookmarked ? 'bookmarked' : ''}`}
        onClick={onBookmark}
        aria-label={isBookmarked ? 'Bookmarked' : 'Add bookmark'}
        title={isBookmarked ? 'Bookmarked' : 'Add bookmark'}
      >
        {isBookmarked ? '★' : '☆'}
      </button>
      <button
        className="toolbar-button"
        onClick={() => onPanel('bookmarks')}
        title="Open bookmarks"
      >
        Bookmarks
      </button>
      <button
        className="toolbar-button"
        onClick={() => onPanel('history')}
        title="Open browsing history"
      >
        History
      </button>
      <button
        className="toolbar-button"
        onClick={() => onPanel('downloads')}
        title="Open downloads"
      >
        Downloads
      </button>
      <button className="toolbar-button" onClick={() => onPanel('settings')} title="Open settings">
        Settings
      </button>
      <button
        className="toolbar-button assessment-launch"
        onClick={onAssessment}
        title="Open demonstration examination"
      >
        Demo exam
      </button>
    </div>
  )
}
