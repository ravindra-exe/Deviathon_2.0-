# Pearl Browser testing

Run the deterministic test suite with:

```text
npm test
```

The Vitest suite runs in a Node environment and uses isolated temporary directories. It covers:

- Versioned persistence creation, reloads, atomic writes, corruption backups, malformed data filtering, and preference/session storage.
- Bookmark duplicate prevention and removal.
- History recording, filtering, removal, clearing, URL policy, and the history-enabled preference.
- Direct URL normalization and allowlisted Google, Bing, and DuckDuckGo search URL construction.
- Download state transitions through an injected `will-download` seam, including progress, pause/resume, completion, cancellation, metadata persistence, and listener disposal.

The suite does not launch a full Electron desktop window or Chromium. Electron's real renderer navigation, popup blocking, permission handling, native save dialog, and network download plumbing still require manual testing or a future local Electron integration harness. Mocked download items verify Pearl's state-management logic, not Chromium's implementation.

Validation commands:

```text
npm test
npm run typecheck
npm run build
npx eslint src\main src\preload src\shared src\renderer\src
git diff --check
```
