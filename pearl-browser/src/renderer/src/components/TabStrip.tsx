import { useEffect, useRef } from 'react'
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
  const tabElements = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    tabElements.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

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
            ref={(element) => {
              if (element) tabElements.current.set(tab.id, element)
              else tabElements.current.delete(tab.id)
            }}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              const currentIndex = tabs.findIndex((item) => item.id === tab.id)
              let nextIndex: number | undefined
              if (event.key === 'Enter' || event.key === ' ') nextIndex = currentIndex
              else if (event.key === 'ArrowRight')
                nextIndex = Math.min(tabs.length - 1, currentIndex + 1)
              else if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1)
              else if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = tabs.length - 1
              if (nextIndex !== undefined) {
                event.preventDefault()
                const nextTab = tabs[nextIndex]
                if (nextTab) {
                  onActivate(nextTab.id)
                  tabElements.current.get(nextTab.id)?.focus()
                }
              }
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
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
      <button
        className="icon-button new-tab"
        onClick={onNew}
        aria-label="New tab"
        title="New tab (Ctrl+T)"
      >
        +
      </button>
    </div>
  )
}
