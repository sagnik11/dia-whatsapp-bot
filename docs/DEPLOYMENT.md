# Deploying Captain Patch

This runbook takes `main` live: what to create in Cloudflare and Notion, what goes in `.env`, how to start the bot with Docker Compose and pair WhatsApp, how to check it works, and how to add the Patch API Worker and the integrations. Every optional piece stays off until its settings are present, so you can stop after the minimum path and add the rest later.

Commands run from the repository root unless a step says otherwise. If your user is not in the `docker` group, prefix `docker compose` with `sudo`, as [docs/lightsail.md](lightsail.md) does.

## Order of operations

Minimum path to a working bot (tasks, memory, follow-ups, daily brief, Monday review, all in D1):

- [ ] Cloudflare core: D1 database, AI Gateway, API token, account ID (section 1)
- [ ] Server, `.env` and first start (section 3)
- [ ] WhatsApp pairing, then `ALLOWED_GROUP_IDS` (section 4)
- [ ] Smoke test in the group (section 5)
- [ ] Each person sends `@patch setup` and answers the interview (section 5)

Optional layers, in this order. Each one is a few `.env` lines and a container restart:

- [ ] Notion spend log and Brain Dump (section 2). Recommended; you can do it before the first start.
- [ ] Patch API Worker: D1 over a binding, the conversation log in D1, semantic search, attachment archive (section 6)
- [ ] Integrations: Gmail, Google Calendar, GitHub, Sentry (section 7). Not needed to draft replies: paste or screenshot an email instead.
- [ ] Tavily web search and research (section 8)

## 1. Cloudflare core

You need a Cloudflare account on **Workers Paid**, or AI Gateway credits: the default model, `@cf/moonshotai/kimi-k2.6`, is paid-only.

1. **Wrangler.** `npx wrangler login` on the machine you run these commands from. Wrangler is not a project dependency; `npx` fetches it.
2. **D1 database.** `npx wrangler d1 create patch`, or reuse an existing database. Copy its database ID (a UUID, not the name) for `CLOUDFLARE_D1_DATABASE_ID`. The bot creates its tables on startup or on first use. To create them ahead of time instead (every file uses `CREATE ... IF NOT EXISTS`, so re-running is safe):

   ```bash
   for f in migrations/*.sql; do npx wrangler d1 execute patch --remote --file="$f"; done
   ```

3. **AI Gateway.** In the dashboard, open **AI > AI Gateway** and create a gateway named `patch`; that name goes in `CLOUDFLARE_AI_GATEWAY_ID`. (`default` also works and is created automatically on first use.) Turn on logging with a retention you are comfortable with, since prompts and replies are logged, then add a rate limit and a monthly spend alert.
4. **API token.** Under **My Profile > API Tokens**, create a custom token with **Account > Workers AI > Read** and **Account > D1 > Edit** for this account. It goes in `CLOUDFLARE_API_TOKEN`. To keep D1 access separate, put a second, D1-only token in `CLOUDFLARE_D1_API_TOKEN`.
5. **Account ID.** Shown in the Cloudflare dashboard and by `npx wrangler whoami`. It goes in `CLOUDFLARE_ACCOUNT_ID`.

## 2. Notion (spend log and Brain Dump)

Optional. Without Notion the bot runs, but it has no spend-log or Brain Dump tools. Notion holds no tasks. If any Notion setting below is present, `NOTION_API_KEY` is required or the bot refuses to start.

1. Create a Notion **internal integration** with the **Read content**, **Insert content** and **Update content** capabilities. Its secret goes in `NOTION_API_KEY`.
2. **Spend log.** Open the Daily Spend Log database and add the integration under **⋯ > Connections** (it needs Read and Insert content here). Copy the database's **data source ID** into `NOTION_SPEND_DATA_SOURCE_ID`. Its properties must match the table in the README's [Founder spend log](../README.md#founder-spend-log) section: `Spend`, `Amount`, `Date`, `Paid by`, `Payment method`, `Category`, `Vendor`, `Notes`, `Reimbursable`.
3. **Brain Dump.** Open the Brain Dump page and add the integration under **⋯ > Connections** (it needs Read and Update content here). Copy the page ID from the end of the page URL into `NOTION_BRAIN_DUMP_PAGE_ID`.
4. **Payers.** Put each founder's Notion user ID in `NOTION_SPEND_PAYER_MAP_JSON`, keyed by the name founders use for the payer in messages, for example `{"sagnik":"<notion-user-id>","tanvi":"<notion-user-id>"}`. Keys are matched case-insensitively. A spend for a payer who is not in the map is refused with an error that names `NOTION_SPEND_PAYER_MAP_JSON`. One way to find the IDs is Notion's list-users API (`GET https://api.notion.com/v1/users`) called with the integration secret; that call needs the integration's user-information capability.

`NOTION_KNOWLEDGE_ENABLED` (workspace search) and `NOTION_SCRIPT_SOURCE_MAP_JSON` (the Dekhte Hai script reader) stay off by default. Read the README's Notion section before turning on workspace search.

## 3. Server, `.env` and first start

The bot is a long-running Node process driving headless Chromium (WhatsApp Web), plus a local whisper.cpp sidecar for voice notes. `compose.yaml` runs both. It needs outbound internet only; no inbound ports. Give it at least 2 GB of RAM; 4 GB is safer with Whisper. [docs/lightsail.md](lightsail.md) covers creating an Ubuntu instance, installing Docker, SSH and backups.

```bash
git clone https://github.com/sagnik11/dia-whatsapp-bot.git
cd dia-whatsapp-bot
cp .env.example .env && chmod 600 .env
nano .env
```

Minimum `.env`. Everything else in `.env.example` can stay at its default:

```dotenv
CLOUDFLARE_ACCOUNT_ID=...
# Workers AI Read + D1 Edit
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_AI_GATEWAY_ID=patch
# The D1 UUID, not its name
CLOUDFLARE_D1_DATABASE_ID=...

# Section 2, if you use Notion
NOTION_API_KEY=...
NOTION_SPEND_DATA_SOURCE_ID=...
NOTION_SPEND_PAYER_MAP_JSON={"sagnik":"<notion-user-id>","tanvi":"<notion-user-id>"}
NOTION_BRAIN_DUMP_PAGE_ID=...

TIMEZONE=Asia/Kolkata
BOT_NAME=Captain Patch
BOT_TRIGGER=@patch
```

Compose sets `DATA_DIR`, `PUPPETEER_EXECUTABLE_PATH` and `WHISPER_TRANSCRIPTION_URL` itself, overriding `.env`.

The defaults match the founders' decisions: 90 days of group conversation (`CONVERSATION_RETENTION_DAYS=90`), a daily brief at 09:00 (`FOUNDER_BRIEF_TIME`), a Monday review at 09:30 (`WEEKLY_REVIEW_DAY`, `WEEKLY_REVIEW_TIME`) and nightly memory at 23:30 (`MEMORY_DISTILL_TIME`), all in `TIMEZONE`. Set any of the three times empty to turn that job off. `CONVERSATION_RETENTION_DAYS=0` is accepted only when all three times are empty. The admin and ops tools are on by default (`ADMIN_OPS_ENABLED=true`, see [docs/admin-ops.md](admin-ops.md)), and subscriptions and budgets need only D1 (see [docs/finance.md](finance.md)).

**Upgrading an existing server** (the old Azure + Notion-tasks version): pull `main`, then delete `AZURE_OPENAI_*`, `NOTION_DATA_SOURCE_ID`, the `NOTION_*_PROPERTY` lines, `NOTION_DEFAULT_STATUS`, `NOTION_DEFAULT_ASSIGNEE_ID`, `TASK_DIGEST_*` and every `NOTION_WEBHOOK_*` / `NOTION_NOTIFICATION_GROUP_IDS` / `NOTION_NOTIFY_BOT_EVENTS` line, and add the Cloudflare lines above. Keep the `dia-data` Docker volume: it holds the WhatsApp session.

Start it in the foreground the first time, because it prints the WhatsApp QR code:

```bash
docker compose up --build dia
```

`dia` waits until the `whisper` service passes its health check. The first start downloads the Whisper model into the `whisper-models` volume, so it can take a few minutes. Then look for these lines (the names assume the default `BOT_NAME`):

- `Phase 3 integrations configured`, with an `integrations` list that is empty until section 7
- `Task list schema is ready in Cloudflare D1`, `Phase 1 schema is ready in Cloudflare D1` and, with admin and ops on, `Admin and ops schema is ready in Cloudflare D1`
- `Chief-of-staff services configured`, one line showing what is on: `model`, `gateway`, `brainDump`, `spendLog`, `dailyBrief`, `weeklyReview`, `memoryDistill`, `d1Route`, `conversationStore`, `semanticMemory`, `archiveAttachments`
- `Scan the QR code with the dedicated WhatsApp account`, followed by the QR code (section 4)

If something is wrong, it stops early:

- A missing or invalid setting exits with a validation error that names the variable, before any of the lines above.
- A wrong D1 ID or token logs `Captain Patch failed to start` with an error that begins `D1 query failed (` followed by the HTTP status and Cloudflare's message. Check that `CLOUDFLARE_D1_DATABASE_ID` is the UUID and that the token has D1 Edit on the same account.

## 4. WhatsApp pairing and allowlists

1. With `docker compose up --build dia` still in the foreground, open WhatsApp on the bot's phone, go to **Linked devices > Link a device** and scan the QR code in the terminal. Wait for `WhatsApp session authenticated` and then `Captain Patch is connected to WhatsApp`; the second line is the ready signal.
2. With `LIST_GROUPS_ON_START=true` (the default), the bot then logs one `Available WhatsApp group` line per group, with `groupId` and `groupName`. Copy the `groupId` of the founders' group (it ends in `@g.us`). If the list fails, send any message in the group and copy the `groupId` from `Observed WhatsApp group from an incoming message`.
3. Stop it with `Ctrl+C`. In `.env`, set `ALLOWED_GROUP_IDS` to that ID (comma-separated for several) and `LIST_GROUPS_ON_START=false`. Then start it in the background and follow the logs:

   ```bash
   docker compose up -d --force-recreate
   docker compose logs -f --since 2m dia
   ```

4. Leave `AUTHORIZED_USER_IDS=*` (the `.env.example` default): everyone in the allowed group can use Patch, with no limits, and each person gets their own private memory. Anyone sending `@patch hello` now gets a normal reply.
5. To restrict it to some people instead, empty `AUTHORIZED_USER_IDS`, recreate the container, have each of them send `@patch hello`, copy every ID from their `Ignored trigger from unauthorized sender` log line (`senderIds`, both the `@lid` and `@c.us` forms) into `AUTHORIZED_USER_IDS`, and recreate again.

The `dia-data` volume holds the WhatsApp session, so later rebuilds do not need a new QR code.

## 5. Smoke test

In the allowed group, as a founder, check each reply and its entry in the AI Gateway logs:

- [ ] `@patch add tasks: renew the domain by Friday, Tanvi to call Rahul` → two tasks confirmed, each with a `#<id>`
- [ ] `@patch what's due this week?` → lists them
- [ ] `@patch mark #<id> done` → a 🎉 confirmation; `@patch undo that` → the change is reverted
- [ ] `@patch add to spend log: chai 120 upi` → a new row in the Notion spend log (needs section 2)
- [ ] `@patch put this in the brain dump: test note` → appended to the Brain Dump page (needs section 2)
- [ ] Send a PDF with the caption `@patch what is this?` → answered from its contents
- [ ] Reply to a voice note with `@patch summarize this` → answered from the transcript
- [ ] `@patch I told Rahul I'd send the DPA by Friday` → an `F<id>` follow-up
- [ ] `@patch remember that we price per repo` → an `M<id>` memory
- [ ] The next morning at `FOUNDER_BRIEF_TIME` (09:00): the brief arrives and covers only what was said in the group

Then each person on the allowlist sends `@patch setup` and answers the 22 questions by replying to each one (about 10 minutes; `pause setup` and `@patch setup` again to resume). Afterwards, check:

- [ ] Paste an email and send `@patch reply to this in my tone` → a draft in your voice
- [ ] `@patch too formal, I never say Dear` → a revised draft and "📝 Noted for next time"
- [ ] `@patch show my profile` → your voice guide and rules

Anyone who joins the group later just runs `@patch setup` (with `AUTHORIZED_USER_IDS=*`). See [docs/voice.md](voice.md).

## 6. Patch API Worker (D1 binding, conversation log in D1, semantic search, archive)

Optional. The Worker in `worker/` gives the bot D1 over a binding instead of the REST API, moves the group conversation into D1, and enables semantic search (Vectorize) and the R2 attachment archive. [docs/platform.md](platform.md) is the full guide. These are its commands in order, run from `worker/`:

```bash
cd worker
npx wrangler login
npx wrangler d1 list
# Put the bot's database name and id in wrangler.toml under [[d1_databases]]
# (database_name, database_id; the binding stays DB). Optional sync tables:
npx wrangler d1 execute <database-name> --remote --file=../migrations/0006_platform.sql
npx wrangler vectorize create patch-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index patch-memory --property-name=group_id --type=string
npx wrangler vectorize create-metadata-index patch-memory --property-name=kind --type=string
npx wrangler r2 bucket create patch-files
openssl rand -hex 32
npx wrangler secret put PATCH_API_TOKEN
npx wrangler deploy
```

- The names match `worker/wrangler.toml`: Vectorize index `patch-memory` (1,024 dimensions for `@cf/baai/bge-m3`, cosine) and R2 bucket `patch-files`. Create both metadata indexes (`group_id`, `kind`) **before the first sync**: Vectorize only filters vectors inserted after a property is indexed.
- Keep the bucket private. Paste the `openssl` output when `wrangler secret put` asks for the value.
- `AI_GATEWAY_ID` under `[vars]` in `wrangler.toml` (default `default`) sends embedding calls through AI Gateway. Set it to the same name as `CLOUDFLARE_AI_GATEWAY_ID` (`patch` above) to see them in the same gateway.

Check the deploy with the URL Wrangler printed. Without the `authorization` header the same call must return `401`:

```bash
curl -s https://patch-api.<subdomain>.workers.dev/d1/query \
  -H "authorization: Bearer $PATCH_API_TOKEN" -H "content-type: application/json" \
  -d '{"sql":"SELECT COUNT(*) AS n FROM tasks","params":[]}'
```

Then add to the bot's `.env` and run `docker compose up -d --force-recreate`:

```dotenv
PATCH_API_URL=https://patch-api.<subdomain>.workers.dev
# Same value as the Worker secret
PATCH_API_TOKEN=...
SEMANTIC_MEMORY=true
ARCHIVE_ATTACHMENTS=true
# The default: with PATCH_API_URL set, the conversation log lives in D1
CONVERSATION_STORE=auto
```

- `Chief-of-staff services configured` now shows `d1Route: "patch-api-worker"` and `conversationStore: "d1"`, with `semanticMemory` and `archiveAttachments` true.
- On this first start the bot copies the local conversation history still inside `CONVERSATION_RETENTION_DAYS` into D1, clears the local table, and logs `Moved the conversation log from local SQLite into D1` (only when there was something to move).
- `SEMANTIC_MEMORY=true` adds the `semantic_search` tool and a silent sync about every 10 minutes that backfills existing memories and tasks first, and keeps up with edits and deletes after that.
- Once `SEMANTIC_MEMORY` is on, semantic search also covers the group conversation (when it is stored in D1) and the Notion Brain Dump, with no extra settings.

**Rollback.** Keep `CLOUDFLARE_D1_DATABASE_ID` pointing at the same database. Clear `PATCH_API_URL` and `PATCH_API_TOKEN` (they must be set together), set `SEMANTIC_MEMORY=false` and `ARCHIVE_ATTACHMENTS=false` (both need the Worker), and recreate the container; the stores go back to the REST API. Also set `CONVERSATION_STORE=d1` to keep reading the conversation history that is now in D1; with `auto` the bot goes back to an empty local log.

## 7. Integrations (optional)

Gmail, Google Calendar, GitHub and Sentry are each off until all of their variables are set. A half-configured service stops the bot at startup with a message naming what is missing. Nothing here runs on a schedule; every call starts from a founder's message. Reference: [docs/integrations.md](integrations.md).

**The go-ahead rule.** Drafts and proposals are free: Patch saves Gmail drafts (`E<id>`) and records meeting proposals (`EV<id>`) without asking, and a proposal does not touch the calendar. It sends an email or books a meeting only after a founder's own message says `send E<id>` or `book EV<id>` (or "go ahead and send E12", "EV3 works, book it"). The check is in code (`src/go-ahead.ts`), not the prompt. Quoted text, negations, deferrals ("send E12 tomorrow") and questions ("should we send E12?") are refused, and each item runs at most once. A plain "send it" only sends a draft made in that same message. Drafts and proposals are tracked in the D1 table `outbound_actions`.

### Google (Gmail and Calendar)

1. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project and enable the **Gmail API** and the **Google Calendar API**.
2. Configure the **OAuth consent screen**. With Google Workspace, choose **Internal**. With a personal Gmail account, choose **External**, add the founders' address as a test user, then **publish the app to production**: refresh tokens of apps left in Testing expire after 7 days. An "unverified app" warning at sign-in is expected.
3. Under **Credentials > Create credentials > OAuth client ID**, choose application type **Desktop app**. Copy the client ID and secret.
4. Get the refresh token on a laptop with a browser, not on the server. `npm run google-auth` runs `tsx scripts/google-auth.ts`, which listens on `127.0.0.1` of the machine it runs on and waits for Google to redirect the browser there. The Docker image contains neither the script nor `tsx`. On the laptop you need Node 24 and a clone of the repo:

   ```bash
   git clone https://github.com/sagnik11/dia-whatsapp-bot.git
   cd dia-whatsapp-bot
   PUPPETEER_SKIP_DOWNLOAD=true npm install
   cp .env.example .env
   # Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env; the script needs only these two
   npm run google-auth
   ```

   (`PUPPETEER_SKIP_DOWNLOAD=true` skips the Chromium download, which this step does not need.) The script prints `Open this URL in a browser and sign in with the account in GOOGLE_ACCOUNT_EMAIL:`, a Google sign-in URL, and `Waiting for Google to redirect back (5 minutes)...`. Open the URL, sign in as the account Patch should use, and approve the three scopes: `gmail.compose` (create and send drafts), `gmail.readonly` (search, reply in a thread) and `calendar.events` (read events, book on "book EV<id>"). The tab then shows `Captain Patch is authorized. You can close this tab.` and the terminal prints:

   ```text
   Add this line to .env and keep it secret:

   GOOGLE_REFRESH_TOKEN=<token>
   ```

   It warns if a scope was not granted, and prints only the refresh token, never an access token. If Google returns no refresh token, remove the app at <https://myaccount.google.com/permissions> and run it again. To run it on a headless host with Node instead, set `GOOGLE_AUTH_PORT` to a fixed port and forward it from the laptop with `ssh -L <port>:127.0.0.1:<port>`. Delete the laptop's `.env` when you are done.

5. On the server, add these to `.env` and run `docker compose up -d --force-recreate`. The first four go together:

   ```dotenv
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REFRESH_TOKEN=...
   # The account you signed in with; the From address of drafts
   GOOGLE_ACCOUNT_EMAIL=...
   # Optional: gmail, calendar, or both (the default)
   GOOGLE_SERVICES=gmail,calendar
   # Optional: a calendar other than primary
   GOOGLE_CALENDAR_ID=primary
   ```

To revoke access, remove the app at <https://myaccount.google.com/permissions>. Patch then reports that sign-in was rejected; run `npm run google-auth` again for a new token.

### GitHub

Create a **fine-grained personal access token** (GitHub > Settings > Developer settings > Fine-grained tokens):

- **Resource owner:** the organization that owns the repos. An org admin may need to approve the token.
- **Repository access:** Only select repositories, the same ones you list in `GITHUB_REPOS`.
- **Repository permissions, all read-only:** Pull requests, Contents (tags, releases, commits), Checks, Commit statuses. Metadata is added automatically. These cover every call Patch makes; it never writes to GitHub.
- An expiry, with a calendar reminder to rotate it.

```dotenv
GITHUB_TOKEN=...
# owner/name, comma separated
GITHUB_REPOS=owner/app,owner/api
```

Both are needed together.

### Sentry

Patch only reads issues. The narrowest token is an internal integration (Sentry > Settings > Custom Integrations > Create New Integration > Internal Integration) with **Project: Read** and **Issue & Event: Read**. A user auth token with the `project:read` and `event:read` scopes also works. Organization auth tokens (the `org:ci` kind used for source maps) cannot read issues.

```dotenv
SENTRY_AUTH_TOKEN=...
# Organization slug
SENTRY_ORG=...
# Project slugs, comma separated
SENTRY_PROJECTS=app,api
# EU region: https://de.sentry.io; self-hosted: your instance's URL
SENTRY_BASE_URL=https://sentry.io
```

`SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECTS` are needed together. `INTEGRATIONS_TIMEOUT_MS` (default `15000`) caps each GitHub, Sentry or Google API call.

### Check the integrations

After `docker compose up -d --force-recreate`, the startup line `Phase 3 integrations configured` lists what is on, for example `"integrations":["gmail","calendar","github","sentry"]`. Then try `@patch what's on my calendar tomorrow?`, `@patch any mail from Acme this week?`, `@patch what merged this week?` and `@patch any new errors in Sentry since yesterday?`. To test the go-ahead rule, ask for a draft to your own address and reply `send E<id>`.

## 8. Web search (optional)

`TAVILY_API_KEY=...` enables quick web lookups and delegated research (`@patch research …`). `RESEARCH_MAX_SEARCHES` (1–5, default 3) caps the searches in one research run. Recreate the container after setting it.

## Updating and rolling back

```bash
git pull --ff-only origin main
docker compose up -d --build --remove-orphans
docker compose logs -f --since 2m dia
```

Never run `docker compose down -v` (`--volumes`). It deletes the WhatsApp session and the local SQLite database (deduplication, reminders, and the conversation log while it is local) along with the Whisper model cache.

To roll back the bot, `git checkout <previous commit>` and run the same `up -d --build`. The D1 schema only ever adds tables and indexes (`CREATE ... IF NOT EXISTS`, no `ALTER`), so older code leaves newer tables unused. To roll back the Worker, run `npx wrangler rollback` from `worker/`. To stop using the Worker, see the rollback at the end of section 6.

## What it costs (approximate)

- Workers Paid ($5/month).
- Kimi K2.6 usage: about $20/month at 50 commands a day, plus research runs, briefs, the Monday review and nightly memory. The estimate is in [docs/chief-of-staff-plan.md](chief-of-staff-plan.md); check AI Gateway analytics for the real figure.
- D1 fits the included limits at this volume.
- The VPS, and Tavily if enabled.
