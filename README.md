# Captain Patch

[![CI](https://github.com/sagnik11/dia-whatsapp-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/sagnik11/dia-whatsapp-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Captain Patch is Autter's very sarcastic, self-hosted WhatsApp mascot. Add its number to a group, trigger it with `@patch`, and it can answer questions, search the live web, and read or create tasks in Notion through a model routed from Vercel AI Gateway to Azure.

```text
@patch summarize the plan we just discussed
@patch add a task: Sagnik to send the proposal tomorrow at 4pm
@patch which tasks are due this week?
@patch search for today's AI code-review news
```

## Important disclaimer

This project uses [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), which automates WhatsApp Web and is **not an official WhatsApp API**. WhatsApp can change its behavior, log out the session, or restrict the account. Use a dedicated, non-critical number and review WhatsApp's terms before running it.

Meta's official WhatsApp Groups API has restricted eligibility and is generally not a drop-in option for an ordinary personal group. If you need a fully supported bot platform, consider Telegram or Discord.

## Features

- Responds only in group chats and only when the bot is actually mentioned or the configured text trigger is present.
- Accepts triggered commands only from explicitly authorized WhatsApp user IDs; an empty owner allowlist fails closed.
- Keeps a small, in-memory context window; untriggered messages are not sent to the AI Gateway.
- Uses an `azure/<model-name>` endpoint through the OpenAI Responses-compatible Vercel AI Gateway API for controlled Notion reads and writes.
- Creates tasks with title, status, due date, assignee, priority, and task type.
- Reads and filters tasks by title, exact status, and due-date range.
- Optionally performs one bounded Tavily web search per request and returns direct source URLs.
- Knows Autter's public product context and that Sagnik Ghosh and Tanvi are equal co-founders.
- Speaks with Captain Patch's dry, highly sarcastic harbour-master personality while remaining useful and non-abusive.
- Forces explicit task-creation requests through the Notion tool and confirms successful writes with the task link.
- Stores WhatsApp requester, group, message ID, and notes inside the task page body, so the database needs no provenance columns.
- Restricts the bot to an optional group allowlist.
- Deduplicates processed messages with local SQLite.
- Stores the WhatsApp session locally so QR pairing survives restarts.
- Includes Docker support, tests, linting, and CI.

## Requirements

- Node.js 24 or Docker
- A dedicated WhatsApp number
- A [Vercel AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- A Notion internal integration with access to your task database
- Optionally, a [Tavily API key](https://app.tavily.com/) for live web search

## Captain Patch and Autter

Captain Patch is Autter's suspicious harbour master: deeply sarcastic about bad code, fuzzy plans, unnecessary meetings, and preventable chaos, but never cruel or personally abusive. Useful answers always take priority over the joke.

The built-in company context is based on [autter.dev](https://autter.dev/): Autter is the independent assurance layer and merge gate for the AI coding era. It reviews, runs, tests, and verifies changes in isolated sandboxes; checks regressions, dependencies, secrets, and CVEs; connects product and production signals into product memory; and can trace failures through verified fixes. Sagnik Ghosh and Tanvi are represented as equal co-founders and close friends.

## 1. Connect a Notion task tracker

Captain Patch defaults to the following task-tracker schema. Change the property names in `.env` if your database differs:

| Property | Type |
| --- | --- |
| `Task name` | Title |
| `Status` | Status, containing `Not started` |
| `Due date` | Date |
| `Assignee` | Person |
| `Priority` | Select with `High`, `Med`, and `Low` |
| `Task type` | Multi-select with `Tech`, `Marketing`, `Content`, `Misc`, and `Product` |

Create an internal Notion integration, give it **Read content** and **Insert content** access, and add the integration to the database. Copy the database's data source ID from the Notion API or integration tooling.

Notion API versions from 2025-09-03 onward distinguish the database container from its data source. `NOTION_DATA_SOURCE_ID` must be the data source ID.

## 2. Configure Captain Patch

```bash
git clone https://github.com/sagnik11/dia-whatsapp-bot.git
cd dia-whatsapp-bot
npm install
cp .env.example .env
```

Fill in at least:

```dotenv
AI_GATEWAY_API_KEY=...
AI_GATEWAY_MODEL=azure/your-model-name
NOTION_API_KEY=...
NOTION_DATA_SOURCE_ID=...
TAVILY_API_KEY=... # optional
```

Replace `your-model-name` with the exact Azure model name configured for your Gateway account. Captain Patch validates the `azure/<model-name>` prefix at startup so it cannot accidentally use a differently namespaced endpoint. The selected model must support tool calling.

`TAVILY_API_KEY` is optional. When configured, Captain Patch gets a strict `search_web` tool using Tavily's basic search with at most five results. The server enforces one search call per triggered WhatsApp message. Without the key, Captain Patch remains honest that live browsing is unavailable.

Notion person properties require user IDs rather than display names. You can assign unqualified tasks to one person and map names used in WhatsApp:

```dotenv
NOTION_DEFAULT_ASSIGNEE_ID=your_notion_user_id
NOTION_ASSIGNEE_MAP_JSON='{"sagnik":"user-id-1","alex":"user-id-2"}'
```

Unknown names remain unassigned, but Captain Patch records the requested assignee in the task page body.

## 3. Pair WhatsApp and find the group ID

```bash
npm run dev
```

Scan the terminal QR code from the dedicated phone: **WhatsApp → Linked devices → Link a device**.

On startup, Captain Patch logs every group name and ID. Copy the intended ID into `.env`, then restart:

```dotenv
ALLOWED_GROUP_IDS=120363000000000000@g.us
AUTHORIZED_USER_IDS=919999999999@c.us
```

Multiple group IDs can be comma-separated. When the value is empty, every joined group can trigger Captain Patch.

`AUTHORIZED_USER_IDS` is required for commands and accepts any number of comma-separated WhatsApp sender IDs or phone numbers. Add every account belonging to the authorized founders, Sagnik and Tanvi. When the list is empty, Captain Patch blocks every trigger and logs the sender identity candidates without allowing answers, web search, or Notion access. Send `@patch hello` from each founder account, copy its IDs from the `Ignored trigger from unauthorized sender` log entry, add them to this setting, and restart. Everyone else gets a separate no-tools, sarcastic rejection; `UNAUTHORIZED_REPLY` is used only if that model call fails. Commands sent manually from Captain Patch's linked WhatsApp account are supported through the `message_create` event when that account's ID is authorized.

## Run with Docker

```bash
cp .env.example .env
# Fill in .env first
docker compose up --build -d
docker compose logs -f dia
```

The named volume preserves WhatsApp authentication and the deduplication database.

### Deploy on Amazon Lightsail

For a 24/7 deployment on an Ubuntu Lightsail instance—including Docker installation, firewall guidance, SSH-based QR pairing, updates, and backups—follow the [Amazon Lightsail deployment guide](docs/lightsail.md).

## Privacy and security

- Tell group participants that triggered content and requested task records may be sent through Vercel AI Gateway to the selected model provider, task commands may be written to Notion, and search queries may be sent to Tavily when configured.
- Captain Patch buffers only the latest `CONTEXT_MESSAGE_LIMIT` text messages in memory. Set it to `0` to send no preceding context.
- Triggered `@patch` messages and Captain Patch's outgoing replies are written to the application logs for troubleshooting. Ordinary untriggered group messages are not logged.
- Never commit `.env` or the `.data` directory.
- Use `ALLOWED_GROUP_IDS` in any real deployment.
- Use `AUTHORIZED_USER_IDS` to restrict commands to the founders; display names are never trusted for authorization.
- The model cannot write arbitrary Notion content. It can request only the strict `create_notion_task` and read-only `list_notion_tasks` functions, which the server validates.
- Group messages and quoted text are treated as untrusted content in the system instructions.

## Development

```bash
npm run check
npm run build
```

## Architecture

```text
WhatsApp group
    │ @patch
    ▼
Trigger + allowlist ──► in-memory context
    │
    ▼
Vercel AI Gateway / Responses API
    │ model: azure/<model-name>
    ├── normal text ──► WhatsApp reply
    ├── create_notion_task ──► Notion ──► confirmation reply
    ├── list_notion_tasks ───► Notion ──► summarized reply
    └── search_web ──────────► Tavily ──► sourced reply
```

## License

[MIT](LICENSE)
