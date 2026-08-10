# Dia

Dia is a small, self-hosted WhatsApp group assistant. Add its dedicated number to a group, mention `@dia`, and it can answer with an OpenAI model or create a task in Notion.

```text
@dia summarize the plan we just discussed
@dia add a task: Sagnik to send the proposal tomorrow at 4pm
@dia turn the quoted message into a task due Friday
```

## Important disclaimer

This project uses [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), which automates WhatsApp Web and is **not an official WhatsApp API**. WhatsApp can change its behavior, log out the session, or restrict the account. Use a dedicated, non-critical number and review WhatsApp's terms before running it.

Meta's official WhatsApp Groups API has restricted eligibility and is generally not a drop-in option for an ordinary personal group. If you need a fully supported bot platform, consider Telegram or Discord.

## Features

- Responds only in group chats and only when the bot is actually mentioned or the configured text trigger is present.
- Keeps a small, in-memory context window; untriggered messages are not sent to OpenAI.
- Uses OpenAI Responses API function calling for controlled Notion writes.
- Creates tasks with title, status, due date, assignee, requester, source, and notes.
- Restricts the bot to an optional group allowlist.
- Deduplicates processed messages with local SQLite.
- Stores the WhatsApp session locally so QR pairing survives restarts.
- Includes Docker support, tests, linting, and CI.

## Requirements

- Node.js 24 or Docker
- A dedicated WhatsApp number
- An [OpenAI API key](https://platform.openai.com/api-keys)
- A Notion internal integration with access to your task database

## 1. Create the Notion data source

Create a Notion database with these exact properties, or change the corresponding names in `.env`:

| Property | Type |
| --- | --- |
| `Task` | Title |
| `Status` | Status, containing `Not started` |
| `Due date` | Date |
| `Assignee` | Text |
| `Requested by` | Text |
| `Source group` | Text |
| `Source message ID` | Text |
| `Notes` | Text |

Create an internal Notion integration, give it **Insert content** access, and add the integration to the database. Copy the database's data source ID from the Notion API or integration tooling.

Notion API versions from 2025-09-03 onward distinguish the database container from its data source. `NOTION_DATA_SOURCE_ID` must be the data source ID.

## 2. Configure Dia

```bash
git clone https://github.com/sagnik11/dia-whatsapp-bot.git
cd dia-whatsapp-bot
npm install
cp .env.example .env
```

Fill in at least:

```dotenv
OPENAI_API_KEY=...
NOTION_API_KEY=...
NOTION_DATA_SOURCE_ID=...
```

The default model is `gpt-5.6-luna`. You can select another Responses API model with `OPENAI_MODEL`.

## 3. Pair WhatsApp and find the group ID

```bash
npm run dev
```

Scan the terminal QR code from the dedicated phone: **WhatsApp → Linked devices → Link a device**.

On startup, Dia logs every group name and ID. Copy the intended ID into `.env`, then restart:

```dotenv
ALLOWED_GROUP_IDS=120363000000000000@g.us
```

Multiple group IDs can be comma-separated. When the value is empty, every joined group can trigger Dia.

## Run with Docker

```bash
cp .env.example .env
# Fill in .env first
docker compose up --build -d
docker compose logs -f dia
```

The named volume preserves WhatsApp authentication and the deduplication database.

## Privacy and security

- Tell group participants that triggered content may be sent to OpenAI and written to Notion.
- Dia buffers only the latest `CONTEXT_MESSAGE_LIMIT` text messages in memory. Set it to `0` to send no preceding context.
- Never commit `.env` or the `.data` directory.
- Use `ALLOWED_GROUP_IDS` in any real deployment.
- The model cannot write arbitrary Notion content. It can request only the strict `create_notion_task` function, which the server validates.
- Group messages and quoted text are treated as untrusted content in the system instructions.

## Development

```bash
npm run check
npm run build
```

## Architecture

```text
WhatsApp group
    │ @dia
    ▼
Trigger + allowlist ──► in-memory context
    │
    ▼
OpenAI Responses API
    ├── normal text ──► WhatsApp reply
    └── create_notion_task ──► Notion ──► confirmation reply
```

## License

[MIT](LICENSE)
