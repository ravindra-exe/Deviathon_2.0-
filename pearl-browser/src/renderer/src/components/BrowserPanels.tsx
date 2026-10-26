import { useMemo, useState } from 'react'
import type { BrowserCommand, BrowserState } from '../../../shared/browser'

interface BrowserPanelsProps {
  panel: 'bookmarks' | 'history' | 'downloads' | 'settings' | null
  state: BrowserState
  onCommand: (command: BrowserCommand) => void
  onClose: () => void
}

export function BrowserPanels({
  panel,
  state,
  onCommand,
  onClose
}: BrowserPanelsProps): React.JSX.Element | null {
  const [historyQuery, setHistoryQuery] = useState('')
  const history = useMemo(
    () =>
      state.history.filter((entry) => {
        const query = historyQuery.trim().toLowerCase()
        return (
          !query ||
          entry.title.toLowerCase().includes(query) ||
          entry.url.toLowerCase().includes(query)
        )
      }),
    [historyQuery, state.history]
  )
  if (!panel) return null

  return (
    <section className="browser-panel" aria-label={`${panel} panel`}>
      <div className="panel-heading">
        <h2>{panel[0].toUpperCase() + panel.slice(1)}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      {panel === 'bookmarks' && (
        <div className="panel-list">
          {state.bookmarks.length === 0 ? (
            <p className="empty-state">No bookmarks yet.</p>
          ) : (
            state.bookmarks.map((bookmark) => (
              <div className="panel-row" key={bookmark.id}>
                <button
                  className="row-link"
                  onClick={() => onCommand({ type: 'navigate-to-url', url: bookmark.url })}
                >
                  <strong>{bookmark.title}</strong>
                  <small>{bookmark.url}</small>
                </button>
                <button
                  className="text-button"
                  onClick={() => onCommand({ type: 'remove-bookmark', bookmarkId: bookmark.id })}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {panel === 'history' && (
        <div className="panel-list">
          <input
            className="panel-search"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
            placeholder="Search history"
            aria-label="Search history"
          />
          <button
            className="text-button panel-action"
            onClick={() => onCommand({ type: 'clear-history' })}
          >
            Clear browsing history
          </button>
          {!state.preferences.historyEnabled && (
            <p className="notice">History recording is disabled.</p>
          )}
          {history.length === 0 ? (
            <p className="empty-state">No matching history.</p>
          ) : (
            history.map((entry) => (
              <div className="panel-row" key={entry.id}>
                <button
                  className="row-link"
                  onClick={() => onCommand({ type: 'navigate-to-url', url: entry.url })}
                >
                  <strong>{entry.title}</strong>
                  <small>
                    {entry.url} · {new Date(entry.visitedAt).toLocaleString()}
                  </small>
                </button>
                <button
                  className="text-button"
                  onClick={() => onCommand({ type: 'remove-history', historyId: entry.id })}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {panel === 'downloads' && (
        <div className="panel-list">
          {state.downloads.length === 0 ? (
            <p className="empty-state">No downloads yet.</p>
          ) : (
            state.downloads.map((download) => (
              <div className="panel-row" key={download.id}>
                <div className="row-link">
                  <strong>{download.filename}</strong>
                  <small>
                    {download.status} · {download.receivedBytes}
                    {download.totalBytes ? ` / ${download.totalBytes}` : ''} bytes
                  </small>
                </div>
                <div className="row-actions">
                  {download.status === 'progressing' && (
                    <button
                      className="text-button"
                      onClick={() => onCommand({ type: 'pause-download', downloadId: download.id })}
                    >
                      Pause
                    </button>
                  )}
                  {download.status === 'paused' && (
                    <button
                      className="text-button"
                      onClick={() =>
                        onCommand({ type: 'resume-download', downloadId: download.id })
                      }
                    >
                      Resume
                    </button>
                  )}
                  {download.status === 'progressing' || download.status === 'paused' ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        onCommand({ type: 'cancel-download', downloadId: download.id })
                      }
                    >
                      Cancel
                    </button>
                  ) : null}
                  {download.savePath && (
                    <button
                      className="text-button"
                      onClick={() =>
                        onCommand({ type: 'show-download-folder', downloadId: download.id })
                      }
                    >
                      Show folder
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {panel === 'settings' && (
        <div className="settings-list">
          <label>
            Search engine
            <select
              value={state.preferences.searchEngineId}
              onChange={(event) =>
                onCommand({
                  type: 'set-search-engine',
                  engineId: event.target.value as 'google' | 'bing' | 'duckduckgo'
                })
              }
            >
              <option value="google">Google</option>
              <option value="bing">Bing</option>
              <option value="duckduckgo">DuckDuckGo</option>
            </select>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.preferences.historyEnabled}
              onChange={(event) =>
                onCommand({ type: 'set-history-enabled', enabled: event.target.checked })
              }
            />{' '}
            Record browsing history
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.preferences.restoreSession}
              onChange={(event) =>
                onCommand({ type: 'set-restore-session', enabled: event.target.checked })
              }
            />{' '}
            Restore tabs after restart
          </label>
          <p className="notice">
            Session restoration saves validated URLs only, not passwords, forms, or full page state.
          </p>
        </div>
      )}
    </section>
  )
}
