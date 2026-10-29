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
- Milestone 3 adds a local demonstration assessment foundation with main-process state, a replaceable provider, MCQ answers, a trusted desktop deadline display, policy checks, and an event record. It intentionally does not include webcams, AI monitoring, production identity verification, backend submission, or tamper-proof enforcement.
- Phase 2 adds main-process assessment navigation policy evaluation for configured HTTPS host allowlists, explicit local-development exceptions, history-target validation, popup/new-tab restrictions, and blocked-action event records. It does not restrict other operating-system applications or external devices and has no real examination backend.
- Task 4 adds an optional separately runnable Airtable-backed MCQ service and explicit remote provider mode. The local demo remains available; production authentication, deployment hardening, and real credential verification are still required.
- Development remote mode now supports short-lived, single-attempt enrollment tokens for local integration testing only. These tokens are not participant identity verification; production OTP/OIDC or equivalent authentication remains release-blocking.
