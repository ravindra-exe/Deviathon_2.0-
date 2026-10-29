# Pearl assessment backend

This is a separately runnable Fastify service. It reads and writes assessment
records through Airtable; the Electron application never receives the Airtable
PAT. The service is development/demo infrastructure, not a production
authentication or examination platform.

## Run locally

1. From `pearl-browser`, copy `.env.example` to `.env` and fill in the Airtable values:
2. Start the service:

   ```powershell
   Copy-Item .env.example .env
   npm run backend:dev
   ```

3. Check `http://127.0.0.1:8787/health`.

The backend binds to loopback by default. Use a reverse proxy and explicit
origin/authentication controls before exposing it beyond local development.

## Read-only Airtable smoke test

The live smoke test is opt-in and makes real, read-only Airtable API requests.
It does not create attempts, submit answers, update records, or delete data.
Run it from `pearl-browser` after configuring the required values in
`pearl-browser/.env`:

```powershell
npm run test:airtable:live
```

It verifies that `pearl-demo-001` is published, has exactly three active
questions, and that each question has valid `OptionsJSON` containing four
unique options. It also verifies that the student-facing assessment mapping
does not contain `CorrectOptionId`.

The command never prints credentials. Missing variables, Airtable
authentication/permission failures, base or table errors, rate limits, network
failures, and schema mismatches are reported separately where possible. The
normal unit and mocked backend tests do not require Airtable credentials.

## Email OTP authentication

Remote assessment mode exposes `POST /api/auth/otp/request`,
`POST /api/auth/otp/verify`, `GET /api/auth/session`, and
`POST /api/auth/logout`. Configure `PEARL_OTP_SECRET`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `SMTP_SECURE` only in
the untracked `.env`. OTPs are six digits, expire after five minutes, allow
five failed attempts, and have a 60-second resend cooldown. OTPs and session
tokens are not persisted or logged; in-memory sessions are revoked on logout
or backend restart.

Add a `ParticipantEmail` single-line text field to the Airtable `Attempts`
table. Existing records and `ParticipantDisplayName` remain unchanged. OTP
proves control of an email inbox only; the current schema has no participant
roster and therefore does not prove examination enrollment or legal identity.
A production deployment still requires an enrollment allowlist, durable
session/revocation storage, and real SMTP verification.

During an active authenticated remote assessment, Electron may append
sanitized navigation, tab, popup, and camera-status events through
`POST /api/attempts/:attemptId/events`. The backend authorizes the bearer
session and bound attempt and rejects events after submission or expiry. The
current audit store is append-only in memory and is lost when the backend
restarts; it does not store camera frames, page contents, credentials, or raw
form input. A durable audit table is a future storage milestone.

For local integration testing only, set `DEV_ENROLLMENT_ENABLED=true` while
`NODE_ENV` is not `production`. The `POST /api/dev/enrollment-tokens` endpoint
then issues a backend-generated, short-lived, single-attempt bearer token.
Electron's main process requests and holds this token; it is never placed in
React state or renderer code. The endpoint returns `404` when disabled.

## API

- `GET /health`
- `GET /api/assessments/:assessmentId`
- `POST /api/assessments/:assessmentId/attempts`
- `POST /api/attempts/:attemptId/submissions`
- `GET /api/attempts/:attemptId/submission`
- `POST /api/dev/enrollment-tokens` (development only)

Attempt creation, submission, and status requests require the development
enrollment bearer token when enabled. The backend validates published
assessments, active questions, answer option indexes, attempt ownership,
server-side deadlines, and completed-attempt idempotency. Correct-answer fields
are never returned by the assessment endpoint.

To select remote mode in Electron, set these non-secret values before starting
Electron:

```text
PEARL_ASSESSMENT_PROVIDER=remote
PEARL_ASSESSMENT_BACKEND_URL=http://127.0.0.1:8787
PEARL_ASSESSMENT_ID=your-assessment-id
PEARL_ASSESSMENT_DEV_ENROLLMENT=true
```

If remote mode is selected and the backend is unavailable, the assessment
shows a failure state. It does not silently switch to local demo data.
The development enrollment token is not participant identity verification.
Production participant authentication remains a release-blocking requirement.
