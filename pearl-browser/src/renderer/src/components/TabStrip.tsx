import type { BrowserTabState } from '../../../shared/browser'

interface TabStripProps {
  tabs: BrowserTabState[]
  activeTabId: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNew
}: TabStripProps): React.JSX.Element {
  return (
    <div className="tab-strip">
      <div className="brand-mark" aria-label="Pearl Browser">
        <span className="brand-mark-orbit" aria-hidden="true">
          <span />
        </span>
        <span className="brand-mark-word">PEARL</span>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onActivate(tab.id)
            }}
          >
            {tab.isLoading ? (
              <span className="loading-dot" />
            ) : tab.favicon ? (
              <img src={tab.favicon} alt="" />
            ) : (
              <span className="tab-dot" />
            )}
            <span className="tab-title">{tab.title}</span>
            <button
              className="icon-button tab-close"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="icon-button new-tab" onClick={onNew} aria-label="New tab" title="New tab">
        +
      </button>
    </div>
  )
}
