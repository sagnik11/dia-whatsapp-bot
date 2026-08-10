import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import qrcode from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";
import type { DiaAssistant } from "./assistant.js";
import type { ContextBuffer } from "./context-buffer.js";
import type { DedupeStore } from "./dedupe-store.js";
import type { Logger } from "./logger.js";
import { isBotTriggered, removeTextTrigger } from "./trigger.js";

const { Client, LocalAuth } = whatsapp;
const GROUP_LIST_ATTEMPTS = 4;

interface BotOptions {
  assistant: DiaAssistant;
  context: ContextBuffer;
  dedupe: DedupeStore;
  allowedGroupIds: ReadonlySet<string>;
  botTrigger: string;
  dataDir: string;
  listGroupsOnStart: boolean;
  puppeteerExecutablePath?: string;
  logger: Logger;
}

export class WhatsAppBot {
  private readonly client: InstanceType<typeof Client>;
  private readonly discoveredGroupIds = new Set<string>();

  public constructor(private readonly options: BotOptions) {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: join(options.dataDir, "whatsapp") }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        ...(options.puppeteerExecutablePath
          ? { executablePath: options.puppeteerExecutablePath }
          : {}),
      },
    });
  }

  public async start(): Promise<void> {
    this.client.on("qr", (code) => {
      this.options.logger.info("Scan the QR code with the dedicated WhatsApp account");
      qrcode.generate(code, { small: true });
    });

    this.client.on("authenticated", () => {
      this.options.logger.info("WhatsApp session authenticated");
    });

    this.client.on("auth_failure", (message) => {
      this.options.logger.error({ message }, "WhatsApp authentication failed");
    });

    this.client.on("disconnected", (reason) => {
      this.options.logger.warn({ reason }, "WhatsApp disconnected");
    });

    this.client.on("ready", () => {
      void this.onReady().catch((error: unknown) => {
        this.options.logger.error(
          { error },
          "WhatsApp is connected, but startup group discovery failed",
        );
      });
    });

    this.client.on("message", (message) => {
      void this.onMessage(message).catch((error: unknown) => {
        this.options.logger.error({ error }, "Failed to process WhatsApp message");
      });
    });

    await this.client.initialize();
  }

  public async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async onReady(): Promise<void> {
    this.options.logger.info(
      { botId: this.client.info.wid._serialized },
      "Dia is connected to WhatsApp",
    );

    if (!this.options.listGroupsOnStart) {
      return;
    }

    for (let attempt = 1; attempt <= GROUP_LIST_ATTEMPTS; attempt += 1) {
      try {
        const chats = await this.client.getChats();
        for (const chat of chats) {
          if (chat.isGroup) {
            const groupId = chat.id._serialized;
            this.discoveredGroupIds.add(groupId);
            this.options.logger.info(
              { groupId, groupName: chat.name },
              "Available WhatsApp group",
            );
          }
        }
        return;
      } catch (error) {
        this.options.logger.warn(
          { error, attempt, maxAttempts: GROUP_LIST_ATTEMPTS },
          "Could not list WhatsApp groups; retrying after the page settles",
        );
        if (attempt < GROUP_LIST_ATTEMPTS) {
          await delay(attempt * 2_000);
        }
      }
    }

    this.options.logger.warn(
      "Dia remains connected. Send any message in a group to log that group's ID.",
    );
  }

  private async onMessage(message: whatsapp.Message): Promise<void> {
    if (!message.from.endsWith("@g.us") || message.fromMe) {
      return;
    }

    const groupId = message.from;
    if (
      this.options.listGroupsOnStart &&
      !this.discoveredGroupIds.has(groupId)
    ) {
      this.discoveredGroupIds.add(groupId);
      this.options.logger.info(
        { groupId },
        "Observed WhatsApp group from an incoming message",
      );
    }

    const contact = await message.getContact();
    const author = contact.pushname || contact.name || message.author || "Unknown member";
    this.options.context.add(groupId, {
      author,
      body: message.body,
      timestamp: message.timestamp,
    });

    const botId = this.client.info.wid._serialized;
    if (
      !isBotTriggered({
        body: message.body,
        mentionedIds: message.mentionedIds,
        botId,
        textTrigger: this.options.botTrigger,
      })
    ) {
      return;
    }

    if (
      this.options.allowedGroupIds.size > 0 &&
      !this.options.allowedGroupIds.has(groupId)
    ) {
      this.options.logger.warn({ groupId }, "Ignored trigger from non-allowlisted group");
      return;
    }

    const messageId = message.id._serialized;
    if (!this.options.dedupe.claim(messageId)) {
      this.options.logger.info({ messageId }, "Ignored duplicate message");
      return;
    }

    const chat = await message.getChat();
    const quotedMessage = message.hasQuotedMsg ? await message.getQuotedMessage() : null;
    const prompt = removeTextTrigger(message.body, this.options.botTrigger);

    try {
      const reply = await this.options.assistant.respond({
        groupId,
        groupName: chat.name,
        messageId,
        requestedBy: author,
        requestedById: message.author || contact.id._serialized,
        body: prompt || message.body,
        quotedMessage: quotedMessage?.body ?? null,
        recentContext: this.options.context.get(groupId, true),
      });
      await message.reply(reply);
    } catch (error) {
      this.options.logger.error({ error, messageId }, "Assistant request failed");
      await message.reply("I hit an error while handling that. Please try again in a moment.");
    }
  }
}
