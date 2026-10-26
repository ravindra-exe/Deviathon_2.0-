# Milestone 1 limitations and next steps

Milestone 1 provides real HTTPS navigation, search, tabs, loading state, favicons, keyboard shortcuts, and cleanup. The initial new-tab destination is Google.

Known limitations:

- Search engine selection is a code-level setting, not yet exposed in preferences.
- There is no session persistence, downloads UI, history, bookmarks, extension support, or permission prompt UI.
- Popup requests are denied rather than offered as a new tab.
- Navigation errors are represented by tab metadata and the Chromium error page; a dedicated local error surface can be added later.
