# Pearl Browser architecture

Pearl uses a trusted desktop process and two kinds of renderer content:

- The main process owns the `BaseWindow`, `TabManager`, and `NavigationService`.
- A local React `WebContentsView` is the browser chrome. Its preload exposes only the typed `BrowserAPI`.
- Each tab is an independent sandboxed `WebContentsView` with no preload bridge.
- Shared contracts live in `src/shared/browser.ts`, keeping future modules independent of React and Chromium navigation.

The window's chrome view occupies the first 118 pixels. Tab views are resized below it and only the active view is visible. State changes from Chromium are sent to the local chrome over a sender-validated IPC channel.

Future extension points can add settings or history services beside `TabManager` and extend the shared command union. Assessment, AI, webcam analysis, and activity monitoring are intentionally out of scope for this milestone.
