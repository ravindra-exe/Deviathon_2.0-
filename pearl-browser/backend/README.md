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

The optional `GET /api/attempts/:attemptId/proctoring-insights` endpoint uses
the same authenticated session-to-attempt binding. Without an LLM configuration,
the UI still computes its transparent deterministic review level from recorded
events. To enable structured AI notes, add `PEARL_PROCTORING_LLM_API_KEY` and
`PEARL_PROCTORING_LLM_MODEL` to the backend `.env` and restart the backend. The
server selects Google's Gemini API when the model name begins with `gemini-`;
otherwise it uses the configured OpenAI Responses API. Proctoring summaries
send only event IDs, event types, timestamps, and numeric detection metadata.
They exclude participant identity, session/authentication credentials, host and
URL details, search text, and webcam media. Gemini's structured response is
validated against the supplied event IDs, and observed facts shown in the
console are reconstructed from backend records. Deterministic review levels
remain independent of AI-generated interpretations.

For local integration testing only, set `DEV_ENROLLMENT_ENABLED=true` while
`NODE_ENV` is not `production`. The `POST /api/dev/enrollment-tokens` endpoint
then issues a backend-generated, short-lived, single-attempt bearer token.
Electron's main process requests and holds this token; it is never placed in
React state or renderer code. The endpoint returns `404` when disabled.

## API

- `GET /health`
- `POST /api/auth/otp/request`
- `POST /api/auth/otp/verify`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/assessments/:assessmentId`
- `GET /api/assessments/:assessmentId/questions` (verified email session required)
- `POST /api/assessments/:assessmentId/attempts`
- `POST /api/attempts/:attemptId/submissions`
- `POST /api/attempts/:attemptId/events` (authenticated live attempt required)
- `GET /api/attempts/:attemptId/proctoring-insights` (authenticated attempt required)
- `GET /api/attempts/:attemptId/submission`
- `POST /api/dev/enrollment-tokens` (development only)

Attempt creation, submission, and status requests require the development
enrollment bearer token when enabled. The backend validates published
assessments, active questions, answer option indexes, attempt ownership,
server-side deadlines, and completed-attempt idempotency. Correct-answer fields
are never returned by either assessment endpoint. OTP-authenticated attempts
write the verified address to `Attempts.ParticipantEmail`; create that
single-line text field if it is not present. Airtable errors from attempt
creation include the upstream status and a schema or permission hint so the
operator can correct the PAT or table setup.

To connect the Electron Live Assessment flow to this backend, set these
non-secret values before starting Electron:

```text
PEARL_ASSESSMENT_BACKEND_URL=http://127.0.0.1:8787
PEARL_ASSESSMENT_ID=pearl-demo-001
```

The Live Assessment option always uses email OTP. Demo Mode remains a separate
local-only path. If the backend is unavailable, Live Assessment shows a failure
state and does not switch to demo data. OTP verifies access to an email inbox;
the current schema has no participant roster and therefore does not prove exam
enrollment or legal identity.
