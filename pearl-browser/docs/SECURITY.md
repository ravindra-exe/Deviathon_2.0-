# Pearl Browser security baseline

- Remote tabs have Node integration disabled, context isolation enabled, sandboxing enabled, and web security enabled.
- Remote pages never receive the application preload bridge.
- IPC accepts commands only from the local chrome view and validates command shape and navigation input length.
- Ordinary navigation is limited to HTTP and HTTPS. Non-web navigation is blocked and handed to the OS only through Electron's external opener.
- Popups are denied and permission requests are denied by default.
- The local UI has a restrictive Content Security Policy.
- Persisted metadata is validated before use; corrupted files are moved aside instead of silently overwritten.
- Renderer requests cannot choose arbitrary save paths or invoke shell operations. Download folder opening uses a main-process record selected by ID and requires an explicit UI action.
- History is local sensitive data and is never sent to websites or external AI services.

Downloads use Electron's `will-download` lifecycle, prompt for a save location, do not auto-open files, and treat filenames and URLs as untrusted metadata. The JSON store contains no passwords, form contents, webpage contents, cookies, or cache.

Automated tests exercise persistence validation, URL policy, IPC command allowlisting, and download state seams without weakening production sandboxing or replacing remote tab web preferences. They do not claim to prove Chromium's renderer isolation; that boundary remains enforced by the production configuration and requires an Electron integration review.
