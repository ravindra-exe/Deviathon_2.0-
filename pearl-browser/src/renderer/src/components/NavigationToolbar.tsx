import type { BrowserTabState } from '../../../shared/browser'

interface NavigationToolbarProps {
  activeTab?: BrowserTabState
  onCommand: (type: 'go-back' | 'go-forward' | 'reload' | 'stop-loading') => void
  onNavigate: (value: string) => void
}

export function NavigationToolbar({
  activeTab,
  onCommand,
  onNavigate
}: NavigationToolbarProps): React.JSX.Element {
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('address')
    if (typeof value === 'string') onNavigate(value)
  }
  return (
    <div className="navigation-toolbar">
      <div className="navigation-actions">
        <button
          className="icon-button"
          disabled={!activeTab?.canGoBack}
          onClick={() => onCommand('go-back')}
          aria-label="Back"
        >
          ←
        </button>
        <button
          className="icon-button"
          disabled={!activeTab?.canGoForward}
          onClick={() => onCommand('go-forward')}
          aria-label="Forward"
        >
          →
        </button>
        <button
          className="icon-button"
          onClick={() => onCommand(activeTab?.isLoading ? 'stop-loading' : 'reload')}
          aria-label={activeTab?.isLoading ? 'Stop loading' : 'Reload'}
        >
          {activeTab?.isLoading ? '■' : '↻'}
        </button>
      </div>
      <form className="address-form" onSubmit={submit}>
        <span className="secure-mark">⌁</span>
        <input
          key={activeTab?.id}
          name="address"
          defaultValue={activeTab?.url ?? ''}
          aria-label="Address and search"
        />
        <button className="go-button" type="submit">
          Go
        </button>
      </form>
      <div className="toolbar-spacer" />
      <span className="engine-label">Google search</span>
    </div>
  )
}
