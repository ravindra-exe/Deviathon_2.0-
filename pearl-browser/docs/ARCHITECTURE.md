# Pearl Browser architecture

Pearl uses a trusted desktop process and two kinds of renderer content:

- The main process owns the `BaseWindow`, `TabManager`, and `NavigationService`.
- A local React `WebContentsView` is the browser chrome. Its preload exposes only the typed `BrowserAPI`.
- Each tab is an independent sandboxed `WebContentsView` with no preload bridge.
- Shared contracts live in `src/shared/browser.ts`, keeping future modules independent of React and Chromium navigation.

The window's chrome view occupies the first 156 pixels. Tab views are resized below it and only the active view is visible. State changes from Chromium are sent to the local chrome over a sender-validated IPC channel.

`PersistenceService` owns a versioned, validated JSON store in Electron's user-data directory and writes through a temporary file before renaming. `DownloadManager` owns live `DownloadItem` objects and persists metadata only. Bookmarks, history, preferences, downloads, and optional URL-only session restoration are exposed through shared contracts and allowlisted IPC commands.

`BrowserDataService` keeps bookmark and history mutations out of React and navigation code. Vitest tests use injected storage paths and download event dependencies, while production continues to use Electron's real session and dialog services.

Future extension points can add profile-specific storage or richer download policies beside these services. Assessment, AI, webcam analysis, and activity monitoring are intentionally out of scope.
