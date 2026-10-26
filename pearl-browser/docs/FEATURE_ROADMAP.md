# Milestone 1 limitations and next steps

Milestone 2 provides persistent bookmarks, local browsing history, a download manager, allowlisted search-engine selection, and opt-in URL-only session restoration in addition to Milestone 1 navigation.

Milestone 2.5 adds a deterministic Vitest suite for persistence, browser metadata, navigation normalization, and download state management. Full Chromium/Electron integration coverage remains a future reliability investment.

Known limitations:

- Search engines are limited to Google, Bing, and DuckDuckGo; custom search templates are not supported.
- Session restoration restores URLs, not passwords, forms, cookies, or full page state.
- History controls clear Pearl's history metadata only; they do not clear Chromium cookies, cache, or site data.
- Download resume depends on Electron and server support; cancelled or interrupted downloads are not guaranteed to resume.
- Popup requests are denied rather than offered as a new tab.
- Navigation errors are represented by tab metadata and the Chromium error page; a dedicated local error surface can be added later.
