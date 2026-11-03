# Deploy Captain Patch on Amazon Lightsail

This guide runs Captain Patch continuously on a standard Amazon Lightsail Linux instance. It needs only outbound internet access (WhatsApp, Cloudflare, and optionally Notion and Tavily) plus SSH administration. No inbound ports are exposed.

## What to provision

Create a Lightsail **Linux/Unix** instance with:

- Ubuntu 24.04 LTS
- At least 2 GB RAM for Chromium and Node.js; 4 GB is the safer starting point when local Whisper is enabled
- An x86_64 instance unless you specifically want to maintain an ARM deployment
- A region reasonably close to the WhatsApp users

A static IP is optional because Captain Patch makes outbound connections, but attaching one makes SSH access predictable after stop/start cycles.

In the Lightsail networking firewall, keep SSH/TCP port 22 open only to the IP ranges that need administrative access when practical. Captain Patch does **not** need HTTP, HTTPS, or a custom application port exposed.

## 1. Connect over SSH

Use the browser-based SSH client in Lightsail or connect from your own terminal:

```bash
chmod 400 /absolute/path/to/LightsailDefaultKey.pem
ssh -i /absolute/path/to/LightsailDefaultKey.pem ubuntu@YOUR_LIGHTSAIL_IP
```

If you downloaded the regional private key from Lightsail, use that file. A key created specifically for the instance works the same way. The browser-based SSH client does not need a local key.

All remaining commands run on the Lightsail instance.

## 2. Install Docker and Git

The commands below follow Docker's official Ubuntu repository installation method instead of its development convenience script.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Add Docker's Apt source:

```bash
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Install Docker Engine and the Compose plugin:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

Using `sudo` avoids adding the SSH user to the root-equivalent `docker` group.

## 3. Clone and configure Captain Patch

```bash
git clone https://github.com/sagnik11/dia-whatsapp-bot.git
cd dia-whatsapp-bot
cp .env.example .env
chmod 600 .env
nano .env
```

Set at least these values:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
# Account > Workers AI > Read and Account > D1 > Edit
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_AI_GATEWAY_ID=patch
CLOUDFLARE_AI_MODEL=@cf/moonshotai/kimi-k2.6
CLOUDFLARE_AI_FALLBACK_MODEL=@cf/google/gemma-4-26b-a4b-it
CLOUDFLARE_D1_DATABASE_ID=your_d1_database_uuid
NOTION_API_KEY=your_notion_key
NOTION_BRAIN_DUMP_PAGE_ID=your_brain_dump_page_id
NOTION_SPEND_DATA_SOURCE_ID=your_spend_log_data_source_id
NOTION_SPEND_PAYER_MAP_JSON={"sagnik":"notion-user-id-1","tanvi":"notion-user-id-2"}
NOTION_KNOWLEDGE_ENABLED=false
NOTION_SCRIPT_SOURCE_MAP_JSON={"06e38545-b932-83be-b4c1-87b686b45ee7":"Doc name","89c38545-b932-830f-95bc-07ed911e3893":"Post name"}
NOTION_SCRIPT_SERIES_NAME=Dekhte Hai
TAVILY_API_KEY=your_optional_tavily_key
RESEARCH_MAX_SEARCHES=3
# Optional daily brief written from the group conversation. Leave blank for
# no unprompted messages other than reminders you set.
FOUNDER_BRIEF_TIME=
FOUNDER_BRIEF_GROUP_IDS=your_whatsapp_group_id
# Local, open-source voice transcription. Use base for more accuracy.
WHISPER_MODEL=tiny
WHISPER_THREADS=2
WHISPER_LANGUAGE=auto
BOT_NAME=Captain Patch
BOT_TRIGGER=@patch
TIMEZONE=Asia/Kolkata
```

Create the Cloudflare pieces first (see the README's "Configure Cloudflare" section): a D1 database, an AI Gateway, and one API token with **Workers AI Read** and **D1 Edit**. Patch creates its D1 tables on startup and exits with a clear `D1 query failed` log if the database id or token is wrong. The default Kimi K2.6 model requires Workers Paid or AI Gateway credits. Voice transcription does not call a hosted model: Compose runs the open-source `whisper.cpp` model locally and caches it in the `whisper-models` volume.

Notion is now used only for the Daily Spend Log and the Brain Dump (plus the off-by-default knowledge and script readers). Share the spend database with **Read content** and **Insert content**, and the Brain Dump page with **Read content** and **Update content**. Tasks live in D1, so the integration no longer needs access to a task database.

For an existing deployment, delete `AZURE_OPENAI_*`, `NOTION_DATA_SOURCE_ID`, `NOTION_*_PROPERTY`, `NOTION_DEFAULT_STATUS`, `NOTION_DEFAULT_ASSIGNEE_ID`, `TASK_DIGEST_INTERVAL_HOURS`, `TASK_DIGEST_GROUP_IDS`, and every `NOTION_WEBHOOK_*` / `NOTION_NOTIFICATION_GROUP_IDS` / `NOTION_NOTIFY_BOT_EVENTS` line from `.env`. The four-hour task digest no longer exists. If you previously set up Caddy for Notion webhooks, you can remove that site block and close ports 80 and 443.

To enable company-wide Notion reads, review the integration's Content access, connect only the intended company pages/databases, and change `NOTION_KNOWLEDGE_ENABLED=true`. The Notion API cannot scope searches by teamspace, so do not enable this while unrelated personal pages are shared with the same integration.

Reminders and the group conversation log (kept for `CONVERSATION_RETENTION_DAYS`, default 14) live in the existing `dia-data` volume; do not remove that volume during updates.

Save in `nano` with `Ctrl+O`, press Enter, and exit with `Ctrl+X`. Do not paste credentials directly into shell commands because they may be recorded in shell history.

## 4. Pair the WhatsApp account over SSH

The VPS does not need a monitor. Captain Patch prints the WhatsApp QR code inside your SSH terminal:

```bash
sudo docker compose up --build dia
```

When the QR appears:

1. Open WhatsApp on the dedicated phone.
2. Open **Linked devices** and choose **Link a device**.
3. Point the phone at the QR displayed on your laptop's SSH terminal.
4. Wait for the log message saying Captain Patch is connected.

If the QR is difficult to scan, maximize the terminal, slightly reduce its font size, and wait for a fresh QR. The phone scans the laptop display; it does not need access to the VPS desktop.

Captain Patch will also print the names and IDs of its joined groups. Copy the intended ID, stop the foreground process with `Ctrl+C`, and set the allowlist:

If WhatsApp Web temporarily refuses the full chat-list request, Captain Patch retries without exiting. Send any message in the intended group and Captain Patch will log that group's ID as a fallback.

```bash
nano .env
```

```dotenv
ALLOWED_GROUP_IDS=120363000000000000@g.us
LIST_GROUPS_ON_START=false
```

Multiple IDs can be separated with commas.

Captain Patch also fails closed until an authorized sender is configured. Start log streaming, send `@patch hello` from each Sagnik and Tanvi account, and look for:

```text
Ignored trigger from unauthorized sender
```

Copy the values in that entry's `senderIds` array, then add the IDs belonging to Sagnik and Tanvi to `.env` as a comma-separated list:

```dotenv
AUTHORIZED_USER_IDS=919999999999@c.us,919999999999
```

Restart with `sudo docker compose up -d`. Captain Patch will answer every configured founder account. For other senders it uses a separate no-tools AI call to produce a sarcastic rejection without exposing the normal assistant, search, or Notion tools. `UNAUTHORIZED_REPLY` is the fallback used only if that call fails. Authorization uses WhatsApp IDs, not editable display names.

## 5. Start Captain Patch continuously

```bash
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs -f --tail 100 dia
```

Exit log streaming with `Ctrl+C`; the container continues running. The Compose policy `restart: unless-stopped` brings Captain Patch back after a process failure or instance reboot.

The `dia-data` Docker volume holds the WhatsApp linked-device session and the SQLite deduplication database. Normal container rebuilds keep it, so you should not need to scan a QR on every deployment. Never use `docker compose down -v` unless you deliberately intend to delete persistent bot data.

## Updating Captain Patch

From the repository directory:

```bash
git pull --ff-only
sudo docker compose up -d --build --remove-orphans
sudo docker compose logs -f --tail 100 dia
```

Do not run `docker compose down --volumes`; deleting the volumes removes the saved WhatsApp session, deduplication/reminder database, and Whisper model cache.

## Operations and troubleshooting

Check status and recent logs:

```bash
sudo docker compose ps
sudo docker compose logs --tail 200 dia
```

To watch host resource use:

```bash
sudo docker stats
```

Restart the bot:

```bash
sudo docker compose restart dia
```

`WhatsApp session authenticated` is not the final ready signal. Wait for `Patch is connected to WhatsApp`. If the saved login authenticates but WhatsApp Web never becomes message-ready, the built-in two-minute watchdog exits the process and Docker restarts it automatically.

If WhatsApp logs the linked device out, remove only the saved authentication directory from the volume or recreate the volume, then repeat the foreground QR-pairing step. Back up the volume before deleting anything.

If Chromium exits because the instance is out of memory, move Captain Patch to a larger Lightsail bundle. Avoid relying on swap as the permanent fix.

## Backups

Enable Lightsail automatic snapshots for the instance. AWS currently keeps the latest seven automatic daily snapshots; snapshot storage is billed separately. Automatic snapshots are deleted if their source instance is deleted, so keep an important recovery point as a manual snapshot before replacing or deleting the server.

The WhatsApp session data inside the Docker volume is sensitive. Treat snapshots and any exported volume backups like credentials, restrict access to them, and delete obsolete copies.

## AWS and Docker references

- [Launch a Linux virtual machine with Lightsail](https://docs.aws.amazon.com/hands-on/latest/launch-a-virtual-machine/launch-a-virtual-machine.html)
- [Lightsail automatic snapshots](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html)
- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Install the Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
