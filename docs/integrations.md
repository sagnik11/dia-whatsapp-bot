# Integrations (Phase 3): Gmail, Google Calendar, GitHub and Sentry

Patch can draft emails in Gmail, read the calendar, prepare meetings, propose and book meetings, and give GitHub and Sentry digests. Each service is optional and turns on only when all of its environment variables are set; a half-configured service stops Patch at startup with a message naming what is missing.

Nothing here runs on a schedule. Every call starts from a founder's message, and there are no unprompted digests.

## The go-ahead rule

Patch drafts emails and proposes meetings freely. It sends an email or books a meeting only after a founder explicitly says so in their own message:

- `send E12`, `go ahead and send E12`, `E12 looks good, send it`
- `book EV3`, `go ahead and book EV3`, `EV3 works, book it`

This is enforced by code (`src/go-ahead.ts`), not by the prompt. When the model calls `send_email` or `book_event`, Patch checks the founder's triggered message itself, never the model's arguments, and allows the action only when all of these hold:

1. The message contains an explicit instruction: "send …" / "go ahead and send" for email, "book …" / "go ahead and book" for meetings.
2. The instruction is the founder's own words. Text in a quoted (replied-to) WhatsApp message, lines starting with `>`, and anything inside quotation marks or backticks are ignored. An email or calendar invite that says "send it" never counts.
3. The instruction is not negated, deferred or a question. "don't send E12", "wait until Rahul replies, then send E12", "send E12 tomorrow", "send it to me first", "book EV3 for Friday instead", "should we send E12?" and "did you send E12?" are all refused. Polite requests such as "can you send E12?" are allowed.
4. The ref is named in the message ("send E12"), or the draft or proposal was created while handling this same message ("draft a thank-you to rahul@acme.com and send it"). A plain "send it" never sends a draft made in an earlier message; Patch asks the founder to say "send E12".
5. The ref belongs to this WhatsApp group and is still `drafted` (email) or `proposed` (meeting). An item is executed at most once; a second "send E12" is refused.

When the guard refuses, nothing is sent, and the model is told to ask the founder for the exact words. Every refusal is logged with the ref and message id.

Confirmations come from stored data, not model prose. A draft confirmation shows the recipients, subject, the first lines of the body and `Reply "send E12" to send it.`

## What founders can ask

| Ask | Tool | What happens |
| --- | --- | --- |
| "Draft a reply to Rahul about the DPA" | `search_email`, `draft_email` | Finds the thread and saves a Gmail draft (E<id>). Nothing is sent. |
| "Any mail from Acme this week?" | `search_email` | Read-only: sender, subject, date and snippet. |
| "send E12" | `send_email` | Sends the draft through Gmail and marks it sent. |
| "What's on my calendar tomorrow?" | `list_events` | Reads the calendar. |
| "Prep me for the 4pm with Acme" | `prep_meeting` | Finds the event and gathers attendees, related long-term memories, open follow-ups and open tasks for a briefing. |
| "Set up 30 minutes with rahul@acme.com on Friday at 4" | `list_events`, `propose_event` | Checks for clashes and records a proposal (EV<id>). The calendar is not touched. |
| "book EV3" | `book_event` | Creates the event and emails the invitations (`sendUpdates=all`). |
| "What merged this week?", "Is CI red?" | `github_activity` | Merged PRs, open PRs waiting on review, failing checks on the default branch. |
| "Draft release notes for app since v1.4.0" | `draft_release_notes` | Merged PR titles since the tag, grouped into Features, Fixes and so on. Nothing is published. |
| "Any new errors in Sentry since yesterday?" | `sentry_issues` | Unresolved issues that are new or regressed, with event and user counts and links. |

## The outbound actions ledger

Every draft and proposal is recorded in the D1 table `outbound_actions` (see `migrations/0005_integrations.sql`; Patch also creates it on first use):

| Column | Meaning |
| --- | --- |
| `id`, `kind` | `E<id>` for `email`, `EV<id>` for `calendar` |
| `status` | `drafted` → `sent` for email, `proposed` → `booked` for meetings (`cancelled` is reserved) |
| `group_id` | The WhatsApp group it was created in; refs never cross groups |
| `summary`, `payload` | Recipients and subject, or title and time; the full draft or proposal as JSON, plus the API result once executed |
| `external_id` | Gmail draft id, then the sent message id; the Google Calendar event id once booked |
| `created_by`, `created_at`, `source_message_id` | Who asked, when, and from which WhatsApp message |
| `executed_by`, `executed_at` | Which founder said "send" / "book", and when |

Every create, send and booking is also written to `audit_events`. Booking uses a deterministic Google Calendar event id, so a retried booking cannot create a second event.

## Setup: Google (Gmail and Calendar)

Patch uses one Google account (the one in `GOOGLE_ACCOUNT_EMAIL`) through an OAuth refresh token. It calls the Gmail and Calendar REST APIs directly with `fetch`; there is no Google SDK.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or reuse one) and enable the **Gmail API** and the **Google Calendar API**.
2. Configure the **OAuth consent screen**. With Google Workspace, choose **Internal**. With a personal Gmail account, choose **External**, add the founders' address as a test user, and then **publish the app to production**: refresh tokens of apps left in "Testing" expire after 7 days. Google may show an "unverified app" warning to you; that is expected for an app only you use.
3. Under **Credentials → Create credentials → OAuth client ID**, choose application type **Desktop app**. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. On a machine with a browser (your laptop is fine), run:

   ```sh
   npm run google-auth
   ```

   It starts a temporary listener on `127.0.0.1`, prints a Google sign-in URL, and waits up to 5 minutes. Sign in as `GOOGLE_ACCOUNT_EMAIL` and approve. The script uses PKCE, prints only the refresh token, and warns if a scope was not granted. Set `GOOGLE_AUTH_PORT` if you need a fixed port.
5. Put the printed value in the server's `.env` as `GOOGLE_REFRESH_TOKEN`, set `GOOGLE_ACCOUNT_EMAIL`, and restart Patch.

Scopes requested, and why:

| Scope | Used for |
| --- | --- |
| `gmail.compose` | Create drafts and send them (`drafts.create`, `drafts.send`) |
| `gmail.readonly` | `search_email`, and reading a thread's headers to reply in it |
| `calendar.events` | Read events, and create one when a founder says "book EV<id>" |

Optional: `GOOGLE_SERVICES=gmail` or `GOOGLE_SERVICES=calendar` turns on only one of the two, and `GOOGLE_CALENDAR_ID` picks a calendar other than `primary`. Access tokens are cached in memory until shortly before they expire and are never logged. To revoke access, remove the app at <https://myaccount.google.com/permissions>; Patch then reports that sign-in was rejected and asks you to run `npm run google-auth` again.

## Setup: GitHub

Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):

- **Resource owner:** the organization that owns the repos (an org admin may need to approve the token).
- **Repository access:** *Only select repositories*, the same repos you list in `GITHUB_REPOS`.
- **Repository permissions, all read-only:** Pull requests, Contents (tags, releases, commits), Checks, Commit statuses. Metadata is added automatically.
- Give it an expiry and put a reminder on the calendar to rotate it.

Then set `GITHUB_TOKEN` and `GITHUB_REPOS=owner/app,owner/api`. Patch only reads the listed repos; a founder can name one by `owner/name` or just `name`.

## Setup: Sentry

Patch needs read access to issues. The narrowest option is an **internal integration** (Sentry → Settings → Custom Integrations → Create New Integration → Internal Integration) with **Project: Read** and **Issue & Event: Read**; copy its token. A personal **user auth token** with the `project:read` and `event:read` scopes also works. Organization auth tokens (the `org:ci` kind used for source maps) cannot read issues.

Then set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` (the organization slug) and `SENTRY_PROJECTS` (project slugs, comma separated). For the EU region set `SENTRY_BASE_URL=https://de.sentry.io`; for self-hosted Sentry use your instance's URL.

## Environment variables

| Variable | Required | Default |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Gmail/Calendar | — |
| `GOOGLE_REFRESH_TOKEN` | For Gmail/Calendar | from `npm run google-auth` |
| `GOOGLE_ACCOUNT_EMAIL` | For Gmail/Calendar | — |
| `GOOGLE_SERVICES` | No | `gmail,calendar` |
| `GOOGLE_CALENDAR_ID` | No | `primary` |
| `GITHUB_TOKEN`, `GITHUB_REPOS` | For GitHub | — |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECTS` | For Sentry | — |
| `SENTRY_BASE_URL` | No | `https://sentry.io` |
| `INTEGRATIONS_TIMEOUT_MS` | No | `15000` (per API call) |

## Limits

- Emails are plain text with no attachments. Patch never guesses an address; it asks, or finds it with `search_email`.
- There is no tool to delete a draft or cancel a proposal yet; delete a Gmail draft in Gmail, and a proposal simply stays unbooked.
- `github_activity` looks at the 100 most recently updated closed PRs and 50 open PRs per repo, and up to 5 repos when none is named.
- `sentry_issues` returns up to 25 new and 25 regressed issues per project (15 shown), busiest first.
- API failures are reported plainly (for example "GitHub denied access (the token may lack a scope …)") and never include tokens.
