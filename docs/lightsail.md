# Deploy Captain Patch on Amazon Lightsail

This guide runs Captain Patch continuously on a standard Amazon Lightsail Linux instance. Its normal WhatsApp/AI/Notion operation needs outbound internet access and SSH administration. The optional Notion notification feature additionally exposes one signed HTTPS webhook through a reverse proxy.

## What to provision

Create a Lightsail **Linux/Unix** instance with:

- Ubuntu 24.04 LTS
- At least 2 GB RAM for Chromium and Node.js; 4 GB is the safer starting point when local Whisper and Supermemory are both enabled
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
AI_GATEWAY_API_KEY=your_vercel_ai_gateway_key
AI_GATEWAY_MODEL=azure/your-model-name
NOTION_API_KEY=your_notion_key
NOTION_DATA_SOURCE_ID=your_notion_data_source_id
NOTION_BRAIN_DUMP_PAGE_ID=your_optional_notion_page_id
NOTION_SPEND_DATA_SOURCE_ID=your_optional_spend_log_data_source_id
NOTION_SPEND_PAYER_MAP_JSON={"sagnik":"notion-user-id-1","tanvi":"notion-user-id-2"}
NOTION_KNOWLEDGE_ENABLED=false
NOTION_DEFAULT_ASSIGNEE_ID=your_notion_user_id
TAVILY_API_KEY=your_optional_tavily_key
RESEARCH_MAX_SEARCHES=3
TASK_DIGEST_INTERVAL_HOURS=4
TASK_DIGEST_GROUP_IDS=your_whatsapp_group_id
FOUNDER_BRIEF_TIME=09:00
FOUNDER_BRIEF_GROUP_IDS=your_whatsapp_group_id
# Local, open-source voice transcription. Use base for more accuracy.
WHISPER_MODEL=tiny
WHISPER_THREADS=2
WHISPER_LANGUAGE=auto
BOT_NAME=Captain Patch
BOT_TRIGGER=@patch
TIMEZONE=Asia/Kolkata
# Enable after bootstrapping the optional memory service below.
SUPERMEMORY_ENABLED=false
SUPERMEMORY_BASE_URL=http://supermemory:6767
SUPERMEMORY_API_KEY=
SUPERMEMORY_CONTAINER_TAG=autter-company
```

Replace `your-model-name` with the exact model name configured for your Azure endpoint, such as `gpt-luna`. The same Azure model handles ordinary messages, screenshots, and PDFs unless `AI_GATEWAY_MEDIA_MODEL` is explicitly overridden. Captain Patch rejects primary model IDs that do not begin with `azure/`. Voice transcription does not call a hosted model: Compose runs the open-source multilingual `whisper.cpp` `tiny` model locally and caches it in the `whisper-models` volume. `TAVILY_API_KEY` is optional and enables quick lookup plus the delegated Patch Research agent; `RESEARCH_MAX_SEARCHES=3` caps each explicit research run. `NOTION_BRAIN_DUMP_PAGE_ID` is optional; when set, share that page with the same Notion integration and enable **Read content** plus **Update content**. `NOTION_SPEND_DATA_SOURCE_ID` is optional; when set, connect the integration to the Daily Spend Log with **Read content** and **Insert content**. The separate payer map can be omitted when `NOTION_ASSIGNEE_MAP_JSON` already contains both founders.

To enable company-wide Notion reads, review the integration's Content access, connect only the intended company pages/databases, and change `NOTION_KNOWLEDGE_ENABLED=true`. The Notion API cannot scope searches by teamspace, so do not enable this while unrelated personal pages are shared with the same integration.

`TASK_DIGEST_INTERVAL_HOURS=4` sends an incomplete-task digest immediately on its first run and every four hours afterward. `TASK_DIGEST_GROUP_IDS` can be omitted when `ALLOWED_GROUP_IDS` already contains the intended destination. Reminders and the next digest time live in the existing `dia-data` volume; do not remove that volume during updates.

Save in `nano` with `Ctrl+O`, press Enter, and exit with `Ctrl+X`. Do not paste credentials directly into shell commands because they may be recorded in shell history.

### Optional: bootstrap Autter's persistent memory

The `memory` Compose profile runs the open-source Supermemory Local binary inside the private Compose network. It reuses `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, and `AI_GATEWAY_MODEL` for extraction and keeps embeddings local.

Start only the memory service first:

```bash
sudo docker compose --profile memory up -d --build supermemory
sudo docker compose logs -f supermemory
```

First boot downloads the verified Linux server binary and local embedding model, then prints a bearer key beginning with `sm_`. Copy that key, exit logs with `Ctrl+C`, and edit `.env`:

```bash
nano .env
```

```dotenv
SUPERMEMORY_ENABLED=true
SUPERMEMORY_BASE_URL=http://supermemory:6767
SUPERMEMORY_API_KEY=sm_the_key_printed_at_first_boot
SUPERMEMORY_CONTAINER_TAG=autter-company
```

The key is local authentication, not your Vercel credential. Do not post it in WhatsApp or commit it. The persistent `supermemory-data` volume retains the graph, auth state, and embedding cache across rebuilds.

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

Restart with `sudo docker compose --profile memory up -d` when memory is enabled, or `sudo docker compose up -d` when it is disabled. Captain Patch will answer every configured founder account. For other senders it uses a separate no-tools AI call to produce a sarcastic rejection without exposing the normal assistant, search, or Notion tools. `UNAUTHORIZED_REPLY` is the fallback used only if that call fails. Authorization uses WhatsApp IDs, not editable display names.

## 5. Start Captain Patch continuously

```bash
# Include --profile memory when SUPERMEMORY_ENABLED=true.
sudo docker compose --profile memory up -d
sudo docker compose ps
sudo docker compose logs -f --tail 100 dia supermemory
```

Exit log streaming with `Ctrl+C`; the container continues running. The Compose policy `restart: unless-stopped` brings Captain Patch back after a process failure or instance reboot.

The `dia-data` Docker volume holds the WhatsApp linked-device session and the SQLite deduplication database. `supermemory-data` holds Autter's persistent company memory when its profile is enabled. Normal container rebuilds keep both volumes, so you should not need to scan a QR or rebuild memory on every deployment. Never use `docker compose down -v` unless you deliberately intend to delete both persistent stores.

## Optional public HTTPS for Notion webhooks

Skip this section unless you want task/comment changes made in Notion to appear proactively in WhatsApp.

1. Attach a Lightsail static IP and point a domain or subdomain (for example `patch.example.com`) to it with a DNS `A` record.
2. Open TCP ports 80 and 443 in the Lightsail networking firewall. Keep the application's port 3000 closed publicly; Compose binds it only to loopback.
3. Install Caddy and create `/etc/caddy/Caddyfile`:

```caddyfile
patch.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

On Ubuntu, install/start the packaged service and validate the configuration:

```bash
sudo apt update
sudo apt install -y caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl https://patch.example.com/health
```

The health response should be `{"ok":true}` after Patch is running with:

```dotenv
NOTION_WEBHOOK_ENABLED=true
NOTION_WEBHOOK_PORT=3000
NOTION_WEBHOOK_PATH=/notion/webhook
NOTION_NOTIFICATION_GROUP_IDS=your_whatsapp_group_id
NOTION_NOTIFY_BOT_EVENTS=false
NOTION_WEBHOOK_VERIFICATION_TOKEN=
```

Create the Notion webhook subscription using `https://patch.example.com/notion/webhook` and subscribe to page and comment events. Watch `sudo docker compose logs -f dia`; the verification request logs a `verificationToken`. Copy it into `NOTION_WEBHOOK_VERIFICATION_TOKEN`, then recreate the container:

```bash
sudo docker compose --profile memory up -d --force-recreate
```

Omit `--profile memory` when memory is disabled. Patch validates all subsequent webhook signatures. Keep the verification token private. Leaving `NOTION_NOTIFY_BOT_EVENTS=false` prevents Patch's own comments, uploads, and task edits from producing echo notifications.

## Updating Captain Patch

From the repository directory:

```bash
git pull --ff-only
sudo docker compose --profile memory up -d --build
sudo docker compose logs -f --tail 100 dia supermemory
```

Omit `--profile memory` and `supermemory` when memory is disabled. Do not run `docker compose down --volumes`; deleting the volumes removes the saved WhatsApp session, deduplication/reminder database, Whisper model cache, and Supermemory graph.

## Operations and troubleshooting

Check status and recent logs:

```bash
sudo docker compose ps
sudo docker compose logs --tail 200 dia
```

For the complete memory-enabled stack, also watch resource use and the sidecar logs:

```bash
sudo docker stats
sudo docker compose --profile memory logs --tail 200 supermemory
```

Restart the bot:

```bash
sudo docker compose restart dia
```

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
