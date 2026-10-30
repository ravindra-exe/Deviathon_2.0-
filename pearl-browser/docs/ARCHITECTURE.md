# Pearl Browser architecture

Pearl uses a trusted desktop process and two kinds of renderer content:

- The main process owns the `BaseWindow`, `TabManager`, and `NavigationService`.
- A local React `WebContentsView` is the browser chrome. Its preload exposes only the typed `BrowserAPI`.
- Each tab is an independent sandboxed `WebContentsView` with no preload bridge.
- Shared contracts live in `src/shared/browser.ts`, keeping future modules independent of React and Chromium navigation.

The window's chrome view occupies the first 112 pixels in the normal two-row shell. Tab views are resized below it and only the active view is visible. For a local new-tab state or a main-frame navigation error, the chrome view is intentionally raised over the content view so the user gets a usable search or retry surface. State changes from Chromium are sent to the local chrome over a sender-validated IPC channel.

Each tab exposes a typed `navigationState` (`idle`, `loading`, `loaded`, `failed`, or
`recovering`). `TabManager` updates it only for main-frame events, ignores cancelled
and subframe failures, and clears failures after `did-finish-load`. The error surface
is rendered by the local React chrome rather than by loading error HTML into a remote
or privileged page. Retry re-enters the normal validated navigation path.

`PersistenceService` owns a versioned, validated JSON store in Electron's user-data directory and writes through a temporary file before renaming. `DownloadManager` owns live `DownloadItem` objects and persists metadata only. Bookmarks, history, preferences, downloads, and optional URL-only session restoration are exposed through shared contracts and allowlisted IPC commands.

`BrowserDataService` keeps bookmark and history mutations out of React and navigation code. Vitest tests use injected storage paths and download event dependencies, while production continues to use Electron's real session and dialog services.

Future extension points can add profile-specific storage or richer download policies beside these services. Assessment, AI, webcam analysis, and activity monitoring are intentionally out of scope.

The assessment foundation is a separate main-process `AssessmentManager` with a replaceable provider interface and a local demonstration provider. Its state machine, deadline, answers, policy checks, and event record are authoritative in the main process; the React assessment surface only submits validated actions through the restricted preload bridge. Live participants must acknowledge the assessment policy before an attempt can begin. Expiration uses a per-session generation guard and submits through the same coordinator; a server-confirmed deadline trigger is required for a late final submission. Closing or cancelling the application does not persist an in-progress local demo assessment.

Assessment navigation policy decisions are evaluated in the main process by
`AssessmentNavigationPolicy.ts`. Active assessment navigation is HTTPS-only and
uses exact host matching with optional explicit subdomains. Local HTTP exceptions,
new tabs, and popup destinations require explicit policy configuration. Address-bar
navigation, webpage navigation events, programmatic loads, history targets, and
tab creation are checked before use; the policy does not depend on React or remote
webpage messages.

The optional remote assessment path is a separately runnable Fastify backend.
Its Airtable client, validation, and routes live under `backend/`; Electron
uses only a typed HTTP provider from the main process. Remote configuration
is explicit, and backend failures produce an assessment failure rather than an
implicit local fallback. OTP sessions are assessment-scoped and permit only
one active login and one bound attempt per session. The backend enforces the
attempt deadline from `StartedAt` and the published duration. Structured
proctoring activity is appended to a local JSON Lines file (by default
`backend-data/proctoring-events.jsonl`, configurable with
`PEARL_AUDIT_LOG_PATH`); it contains event metadata, not webcam frames.
