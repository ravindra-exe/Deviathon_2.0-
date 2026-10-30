# Pearl Browser security baseline

- Remote tabs have Node integration disabled, context isolation enabled, sandboxing enabled, and web security enabled.
- Remote pages never receive the application preload bridge.
- IPC accepts commands only from the local chrome view and validates command shape and navigation input length.
- Ordinary navigation is limited to HTTP and HTTPS. Non-web navigation is blocked and handed to the OS only through Electron's external opener.
- Navigation failures are classified locally for user feedback. Certificate failures remain rejected by Electron's normal certificate validation; Pearl Browser never accepts invalid certificates or disables web security. Retry validates the failed URL again.
- Popups are denied and permission requests are denied by default.
- The local UI has a restrictive Content Security Policy.
- Persisted metadata is validated before use; corrupted files are moved aside instead of silently overwritten.
- Renderer requests cannot choose arbitrary save paths or invoke shell operations. Download folder opening uses a main-process record selected by ID and requires an explicit UI action.
- History is local sensitive data and is never sent to websites or external AI services.

Downloads use Electron's `will-download` lifecycle, prompt for a save location, do not auto-open files, and treat filenames and URLs as untrusted metadata. The JSON store contains no passwords, form contents, webpage contents, cookies, or cache.

Automated tests exercise persistence validation, URL policy, IPC command allowlisting, and download state seams without weakening production sandboxing or replacing remote tab web preferences. They do not claim to prove Chromium's renderer isolation; that boundary remains enforced by the production configuration and requires an Electron integration review.

Assessment mode uses a separate allowlisted IPC surface. The main process owns assessment transitions, answers, deadline, submission state, and event records. Expiration callbacks are tied to the current session generation, and submission transitions prevent duplicate manual/automatic submissions. The local demo provider accepts only the documented `DEMO` code and must not be treated as identity verification. Assessment policy navigation checks use exact host or subdomain matching rather than substring matching, and an empty allowed-host list blocks external HTTPS destinations. Desktop deadline enforcement is not tamper-proof; application closure does not restore an in-progress assessment, and a production examination must validate deadlines and identity with an authoritative backend.

During an active assessment, the main process evaluates every ordinary tab
navigation request against the configured HTTPS host allowlist. HTTP is accepted
only for explicitly listed local-development hosts, Back/Forward validates the
target history entry, and popup/new-tab requests are denied unless configured.
Blocked attempts record a minimal `restricted_action` event with a safe reason
code; URLs, page text, credentials, and unrelated keystrokes are not collected.
These controls restrict Pearl Browser only and cannot prevent access to other
operating-system applications or external devices.

The optional Airtable integration keeps the PAT exclusively in the separate
backend process. The backend validates assessment publication, active
questions, attempt ownership, answer indexes, server-side deadlines, and
idempotent submissions before writing records. It still requires deployment
hardening and production monitoring before real examinations.

Development remote mode uses a backend-generated short-lived bearer token bound
to one assessment and one attempt. The token is stored hashed in backend
memory, required on attempt creation/submission/status requests, and is not
available to the renderer or remote webpages. This token is strictly for local
integration testing and is disabled in production; it is not participant
identity verification. Production OTP/OIDC or equivalent authentication is a
release-blocking requirement.

Email OTP authentication is available for remote assessments. OTP codes use
cryptographic randomness, are stored only as keyed hashes, expire after five
minutes, are single-use, and allow five failed attempts. SMTP credentials
remain backend-only. Opaque session credentials are assessment-scoped, held in
backend memory, and revoked on logout or restart. The backend rejects a second
active session for the same email and assessment and binds each session to at
most one attempt. Email OTP proves mailbox control, not participant enrollment
or legal identity; an enrollment roster and durable production session controls
remain required.

Structured proctoring events are persisted locally as append-only JSON Lines in
`backend-data/proctoring-events.jsonl` by default, or at the path configured by
`PEARL_AUDIT_LOG_PATH`. The log contains assessment/attempt IDs and sanitized
event metadata, not images, recordings, or search text. The backend process
account and storage location must be access-controlled, backed up, and retained
according to the deployment's privacy policy. A failed disk write is returned
as an event-storage failure; it is not reported as successfully recorded.
