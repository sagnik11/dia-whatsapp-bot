# Deploy Captain Patch on Amazon Lightsail

This guide runs Captain Patch continuously on a standard Amazon Lightsail Linux instance. Captain Patch does not serve a website or accept incoming webhooks: it needs outbound internet access and SSH access for administration.

## What to provision

Create a Lightsail **Linux/Unix** instance with:

- Ubuntu 24.04 LTS
- At least 2 GB RAM, because Chromium and Node.js run together
- An x86_64 instance unless you specifically want to maintain an ARM deployment
- A region reasonably close to the WhatsApp users

A static IP is optional because Captain Patch makes outbound connections, but attaching one makes SSH access predictable after stop/start cycles.

In the Lightsail networking firewall, keep SSH/TCP port 22 open only to the IP ranges that need administrative access when practical. Captain Patch does **not** need HTTP, HTTPS, or a custom application port exposed.

## 1. Connect over SSH

Use the browser-based SSH client in Lightsail or connect from your own terminal:

```bash
ssh ubuntu@YOUR_LIGHTSAIL_IP
```

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
NOTION_DEFAULT_ASSIGNEE_ID=your_notion_user_id
TAVILY_API_KEY=your_optional_tavily_key
BOT_NAME=Captain Patch
BOT_TRIGGER=@patch
TIMEZONE=Asia/Kolkata
```

Replace `your-model-name` with the exact model name configured for your Azure endpoint. Captain Patch rejects model IDs that do not begin with `azure/`. `TAVILY_API_KEY` is optional and enables one controlled live-web search per command.

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

The `dia-data` Docker volume holds the WhatsApp linked-device session and the SQLite deduplication database. Normal container rebuilds keep this volume, so you should not need to scan a QR on every deployment.

## Updating Captain Patch

From the repository directory:

```bash
git pull --ff-only
sudo docker compose up -d --build
sudo docker compose logs -f --tail 100 dia
```

Do not run `docker compose down --volumes`; deleting the volume removes the saved WhatsApp session and deduplication database.

## Operations and troubleshooting

Check status and recent logs:

```bash
sudo docker compose ps
sudo docker compose logs --tail 200 dia
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
