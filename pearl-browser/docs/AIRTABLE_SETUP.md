# Airtable setup

Create these tables in the configured base. Field names are case-sensitive.

## Assessments

| Field             | Type             | Example                         |
| ----------------- | ---------------- | ------------------------------- |
| `AssessmentId`    | Single line text | `assessment-1`                  |
| `Title`           | Single line text | `Pearl remote assessment`       |
| `Instructions`    | Long text        | `Read each question carefully.` |
| `DurationMinutes` | Number           | `10`                            |
| `IsPublished`     | Checkbox         | checked                         |

## Questions

| Field             | Type             | Example                    |
| ----------------- | ---------------- | -------------------------- |
| `QuestionId`      | Single line text | `q1`                       |
| `AssessmentId`    | Single line text | `assessment-1`             |
| `Prompt`          | Long text        | `Which option is correct?` |
| `OptionsJSON`     | Long text        | JSON array of four `{ "id", "text" }` option objects |
| `Order`           | Number           | `1`                        |
| `IsActive`        | Checkbox         | checked                    |
| `CorrectOptionId` | Single line text | `option-a`                 |

`CorrectOptionId` is reserved for future server-side grading and is never
returned to Pearl Browser.

`OptionsJSON` must contain exactly four options. Each option needs a unique,
non-empty `id` and a non-empty `text`, for example:

```json
[
  { "id": "option-a", "text": "First answer" },
  { "id": "option-b", "text": "Second answer" },
  { "id": "option-c", "text": "Third answer" },
  { "id": "option-d", "text": "Fourth answer" }
]
```

## Attempts

| Field                    | Type             | Example                                 |
| ------------------------ | ---------------- | --------------------------------------- |
| `AttemptId`              | Single line text | generated UUID                          |
| `AssessmentId`           | Single line text | `assessment-1`                          |
| `ParticipantDisplayName` | Single line text | `Demo Participant`                      |
| `ParticipantEmail`       | Single line text | `participant@example.com`               |
| `StartedAt`              | Date/time        | generated                               |
| `SubmittedAt`            | Date/time        | generated on submission                 |
| `Status`                 | Single select    | `in_progress`, `submitted`, or `expired` |
| `AnswersJSON`            | Long text        | `[{"questionId":"q1","optionIndex":0}]` |
| `SubmissionId`           | Single line text | generated UUID                          |

Create an Airtable Personal Access Token with only the required record
read and write scopes (`data.records:read` and `data.records:write`) and
restrict it to this base. Store it only in the backend
`.env`, which is ignored by Git. Never place it in renderer environment
variables, source maps, IPC responses, or chat.

Run `npm run backend:test` for mock-backed tests. A real Airtable request
requires valid credentials and is not part of the standard test suite.

The local development enrollment token is held in backend memory, expires
quickly, is limited to one assessment attempt, and is not persisted to Airtable.
It is disabled when `NODE_ENV=production` or `DEV_ENROLLMENT_ENABLED` is not
`true`. It is not proof of participant identity; production OTP, OIDC, or
equivalent authentication is a release-blocking requirement.

## Attempts field mismatch

The backend writes these fields when Airtable confirms an authenticated attempt:
`AttemptId` (single line text UUID), `AssessmentId` (single line text),
`ParticipantDisplayName` (single line text), `ParticipantEmail` (single line
text from the verified server session), `StartedAt` (date/time in ISO 8601),
`Status` (single select with exactly `in_progress`, `submitted`, and `expired`),
and `AnswersJSON` (long text). Submission also writes `SubmittedAt` (date/time),
`SubmissionId` (single line text), and updates `Status` and `AnswersJSON`.

If Airtable rejects a write with `HTTP 422 INVALID_MULTIPLE_CHOICE_OPTIONS`,
open the configured base, select the `Attempts` table, and edit the `Status`
field to be a **Single select** whose options include exactly `in_progress`,
`submitted`, and `expired`. Airtable will reject updates that try to create a
new custom option not already in that list.

If Airtable returns `HTTP 422 UNKNOWN_FIELD_NAME` for `ParticipantEmail`, open
the configured base, select the `Attempts` table, add a new field named exactly
`ParticipantEmail`, choose **Single line text**, and save. Existing attempt rows
can leave this field blank. The configured token returned HTTP 403 for Airtable
table metadata, so schema changes must be made in Airtable's UI. Keep the
verified email mapped to this dedicated field; do not rename it to another
field or remove it from the backend payload.
