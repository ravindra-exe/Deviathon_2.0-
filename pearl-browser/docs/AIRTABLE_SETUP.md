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
| `OptionsJSON`     | Long text        | `["Option A","Option B"]`  |
| `Order`           | Number           | `1`                        |
| `IsActive`        | Checkbox         | checked                    |
| `CorrectOptionId` | Single line text | `option-a`                 |

`CorrectOptionId` is reserved for future server-side grading and is never
returned to Pearl Browser.

## Attempts

| Field                    | Type             | Example                                 |
| ------------------------ | ---------------- | --------------------------------------- |
| `AttemptId`              | Single line text | generated UUID                          |
| `AssessmentId`           | Single line text | `assessment-1`                          |
| `ParticipantDisplayName` | Single line text | `Demo Participant`                      |
| `ParticipantEmail`       | Single line text | `participant@example.com`               |
| `StartedAt`              | Date/time        | generated                               |
| `SubmittedAt`            | Date/time        | generated on submission                 |
| `Status`                 | Single line text | `in_progress` or `submitted`            |
| `AnswersJSON`            | Long text        | `[{"questionId":"q1","optionIndex":0}]` |
| `SubmissionId`           | Single line text | generated UUID                          |

Create an Airtable Personal Access Token with only the required record
read/write scopes and restrict it to this base. Store it only in the backend
`.env`, which is ignored by Git. Never place it in renderer environment
variables, source maps, IPC responses, or chat.

Run `npm run backend:test` for mock-backed tests. A real Airtable request
requires valid credentials and is not part of the standard test suite.

The local development enrollment token is held in backend memory, expires
quickly, is limited to one assessment attempt, and is not persisted to Airtable.
It is disabled when `NODE_ENV=production` or `DEV_ENROLLMENT_ENABLED` is not
`true`. It is not proof of participant identity; production OTP, OIDC, or
equivalent authentication is a release-blocking requirement.
