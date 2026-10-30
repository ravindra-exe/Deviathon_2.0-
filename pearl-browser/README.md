# pearl-browser

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Live assessment development

```bash
$ npm run dev:live
```

`dev:live` reads the existing `.env`, verifies the configured assessment backend,
starts the local backend with `npm run backend:dev` when needed, and launches
Electron only after the backend health endpoint responds. It does not switch to
demo mode or create a substitute assessment.

The backend persists structured proctoring activity in
`backend-data/proctoring-events.jsonl` by default. Set `PEARL_AUDIT_LOG_PATH` to
choose another local path. This file contains event metadata only; webcam frames
and recordings are not stored.

### Administrator console

Set `PEARL_ADMIN_EMAILS` in the backend `.env` to a comma-separated allowlist of
administrator email addresses, for example
`PEARL_ADMIN_EMAILS=admin@example.com,operator@example.com`. Addresses are
trimmed and matched case-insensitively. Configure `PEARL_OTP_SECRET` and the
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and
`SMTP_SECURE` settings in that same backend environment so OTPs can be
delivered. Use a long random OTP secret (at least 32 characters). Restart the
backend after changing these values.

Open the console from Pearl Browser's toolbar, enter an allowlisted email, use
the six-digit code delivered to that mailbox, and verify it. Dashboard data is
loaded only after the backend confirms the administrator session. Selecting
the console or entering an email does not grant administrator access.

The console reads assessment, question, attempt, and stored activity data from
the configured backend. It does not write or alter Airtable records. CSV
attempt/event exports are recorded in the append-only
`backend-data/admin-actions.jsonl` log by default; override the location with
`PEARL_ADMIN_AUDIT_LOG_PATH`. AI summaries use structured event metadata only
and are unavailable unless the backend LLM provider is configured.

#### AI Question Generator and Proctoring Summaries

The authenticated Admin Console includes an AI question generator and
on-demand proctoring summaries. Configure the backend `.env` file with the
provider's key and model:

```dotenv
PEARL_PROCTORING_LLM_API_KEY=your_provider_api_key
PEARL_PROCTORING_LLM_MODEL=gemini-3.8-flash
```

These settings are backend-only and shared by both features. Models whose
names start with `gemini-` use Google's official Gemini API; other configured
models use the existing OpenAI Responses API. Restart the backend after
changing configuration. Question generation always requests structured JSON
and never falls back to sample questions. Model responses are validated for
count, shape, duplicate identifiers/text, option count, answer references,
difficulty, and order. Proctoring summaries receive only event IDs, event
types, timestamps, and numeric detection metadata; they never receive
participant identity, session credentials, page URLs, search text, or camera
media. Both features display the configured provider and model where relevant.
Proctoring review levels remain calculated independently by the existing
deterministic rules; Gemini output is an explanation for a human reviewer, not
a misconduct finding or automatic decision.

The current Airtable Questions mapping accepts exactly four options and has no
explanation field. Generated/existing question records are created only after
the administrator explicitly saves a draft. The correct option is written to
the existing `CorrectOptionId` field, while explanations remain available for
review in the editor and are not persisted. Publishing requires a separate
confirmation and changes only the `IsPublished` field of a draft created by
this generator. Student question responses continue to omit answer keys.
Draft-generator registration is stored in
`backend-data/question-generator-drafts.jsonl` by default; override it with
`PEARL_QUESTION_DRAFT_REGISTRY_PATH`.

The current data model has no instructor-to-assessment assignments, enrollment
eligibility records, or persisted grading scores. Consequently access is
administrator-only, candidate eligibility cannot be reported, and scores are
shown as unavailable rather than inferred.

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
