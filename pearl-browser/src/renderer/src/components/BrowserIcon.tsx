export type BrowserIconName =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'secure'
  | 'insecure'
  | 'neutral'
  | 'bookmark'
  | 'history'
  | 'downloads'
  | 'settings'
  | 'menu'
  | 'search'
  | 'close'

const paths: Record<BrowserIconName, React.ReactNode> = {
  back: <path d="m14.5 5-7 7 7 7M8 12h11" />,
  forward: <path d="m9.5 5 7 7-7 7M16 12H5" />,
  reload: <path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4" />,
  stop: <path d="M7 7h10v10H7z" />,
  secure: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v2" />
    </>
  ),
  insecure: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 7.5-2M12 14v2" />
    </>
  ),
  neutral: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4z" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <path d="M3 3v5h5m4-1v5l3 2" />
    </>
  ),
  downloads: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 17v3h16v-3" />
    </>
  ),
  settings: (
    <>
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="m19.4 15 .1.1 1.2.9-1.2 2.1-1.4-.5a7.5 7.5 0 0 1-1.4.8l-.2 1.5h-2.4l-.3-1.5a7.5 7.5 0 0 1-1.5-.8l-1.4.5-1.2-2.1 1.2-.9a7.7 7.7 0 0 1 0-1.7l-1.2-.9 1.2-2.1 1.4.5a7.5 7.5 0 0 1 1.5-.8l.3-1.5h2.4l.2 1.5a7.5 7.5 0 0 1 1.4.8l1.4-.5 1.2 2.1-1.2.9a7.7 7.7 0 0 1 0 1.7Z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />
}

export function BrowserIcon({
  name,
  className
}: {
  name: BrowserIconName
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  )
}
