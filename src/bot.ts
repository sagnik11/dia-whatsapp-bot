import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import qrcode from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";
import type { DiaAssistant } from "./assistant.js";
import { isAuthorizedSender } from "./authorization.js";
import { removeStaleChromiumLocks } from "./chromium-profile.js";
import type { ContextBuffer } from "./context-buffer.js";
import type { DedupeStore } from "./dedupe-store.js";
import type { Logger } from "./logger.js";
import type { MediaIngestionService } from "./media-ingestion.js";
import { serializeMessageId } from "./message-id.js";
import type { ProactiveScheduler } from "./scheduler.js";
import type { AssistantAttachment } from "./types.js";
import { isBotTriggered, removeTextTrigger } from "./trigger.js";

const { Client, LocalAuth } = whatsapp;
const GROUP_LIST_ATTEMPTS = 4;
const WHATSAPP_MESSAGE_CHUNK_SIZE = 3_500;

export function splitWhatsAppMessage(
  output: string,
  maxCharacters = WHATSAPP_MESSAGE_CHUNK_SIZE,
): string[] {
  const chunks: string[] = [];
  let remaining = output.trim();
  while (remaining.length > maxCharacters) {
    let splitAt = remaining.lastIndexOf("\n\n", maxCharacters);
    if (splitAt < Math.floor(maxCharacters / 2)) {
      splitAt = remaining.lastIndexOf("\n", maxCharacters);
    }
    if (splitAt < Math.floor(maxCharacters / 2)) {
      splitAt = remaining.lastIndexOf(" ", maxCharacters);
    }
    if (splitAt < 1) splitAt = maxCharacters;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [""];
}

interface BotOptions {
  assistant: DiaAssistant;
  context: ContextBuffer;
  dedupe: DedupeStore;
  allowedGroupIds: ReadonlySet<string>;
  authorizedUserIds: ReadonlySet<string>;
  unauthorizedReply: string;
  botName: string;
  botTrigger: string;
  dataDir: string;
  listGroupsOnStart: boolean;
  mediaIngestion?: MediaIngestionService;
  scheduler?: ProactiveScheduler;
  puppeteerExecutablePath?: string;
  logger: Logger;
}

export function resolveGroupId(
  message: Pick<whatsapp.Message, "from" | "fromMe" | "to">,
): string | null {
  const chatId = message.fromMe ? message.to : message.from;
  return chatId?.endsWith("@g.us") ? chatId : null;
}

export class WhatsAppBot {
  private readonly client: InstanceType<typeof Client>;
  private readonly discoveredGroupIds = new Set<string>();
  private ready = false;

  public constructor(private readonly options: BotOptions) {
    const profileDirectory = join(options.dataDir, "whatsapp", "session");
    try {
      for (const path of removeStaleChromiumLocks(profileDirectory)) {
        options.logger.warn({ path }, "Removed stale Chromium profile lock");
      }
    } catch (error) {
      options.logger.warn(
        { error, profileDirectory },
        "Could not clean stale Chromium profile locks",
      );
    }

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
      this.ready = false;
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

    // message_create includes both incoming messages and commands manually sent
    // from the WhatsApp account linked to the bot.
    this.client.on("message_create", (message) => {
      void this.onMessage(message).catch((error: unknown) => {
        this.options.logger.error({ error }, "Failed to process WhatsApp message");
      });
    });

    await this.client.initialize();
  }

  public async stop(): Promise<void> {
    this.ready = false;
    await this.options.scheduler?.stop();
    await this.client.destroy();
  }

  public async sendProactive(groupId: string, output: string): Promise<void> {
    if (!this.ready) throw new Error("WhatsApp is not ready");
    if (
      this.options.allowedGroupIds.size > 0 &&
      !this.options.allowedGroupIds.has(groupId)
    ) {
      throw new Error(`WhatsApp group ${groupId} is not allowlisted`);
    }
    await this.sendCompleteMessage(groupId, output);
  }

  private async onReady(): Promise<void> {
    this.ready = true;
    this.options.logger.info(
      { botId: this.client.info.wid._serialized },
      `${this.options.botName} is connected to WhatsApp`,
    );

    this.options.scheduler?.start(async (groupId, output) => {
      await this.sendProactive(groupId, output);
    });

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
      `${this.options.botName} remains connected. Send any message in a group to log that group's ID.`,
    );
  }

  private async onMessage(message: whatsapp.Message): Promise<void> {
    const groupId = resolveGroupId(message);
    if (!groupId) return;

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

    const senderIds = [
      message.author,
      contact.id._serialized,
      contact.number,
      contact.number ? `${contact.number}@c.us` : undefined,
      message.fromMe ? botId : undefined,
      message.fromMe ? botId.split("@")[0] : undefined,
    ].filter((id): id is string => Boolean(id));

    const messageId = serializeMessageId(message.id);
    this.options.logger.info(
      {
        author,
        fromMe: message.fromMe,
        groupId,
        input: message.body,
        messageId,
        senderIds,
      },
      "Received triggered WhatsApp message",
    );

    if (!this.options.dedupe.claim(messageId)) {
      this.options.logger.info({ messageId }, "Ignored duplicate message");
      return;
    }

    if (!isAuthorizedSender(this.options.authorizedUserIds, senderIds)) {
      this.options.logger.warn(
        { author, senderIds },
        "Ignored trigger from unauthorized sender",
      );
      try {
        const rejection = await this.options.assistant.rejectUnauthorized({
          author,
          body: message.body,
          groupId,
          senderId: senderIds[0] ?? "unknown",
        });
        this.options.logger.info(
          { author, groupId, messageId, output: rejection },
          `Sending ${this.options.botName} rejection`,
        );
        await this.client.sendMessage(groupId, rejection);
      } catch (error) {
        this.options.logger.error(
          { error, messageId },
          "Failed to generate unauthorized rejection",
        );
        this.options.logger.info(
          {
            author,
            groupId,
            messageId,
            output: this.options.unauthorizedReply,
          },
          `Sending ${this.options.botName} fallback rejection`,
        );
        await this.client.sendMessage(groupId, this.options.unauthorizedReply);
      }
      return;
    }

    const chat = await message.getChat().catch((error: unknown) => {
      this.options.logger.warn({ error, messageId }, "Could not resolve group name");
      return null;
    });
    const quotedMessage = message.hasQuotedMsg
      ? await message.getQuotedMessage().catch((error: unknown) => {
          this.options.logger.warn(
            { error, messageId },
            "Could not resolve quoted message",
          );
          return null;
        })
      : null;
    const prompt = removeTextTrigger(message.body, this.options.botTrigger);
    const attachments: AssistantAttachment[] = [];
    const mediaMessage = message.hasMedia
      ? message
      : quotedMessage?.hasMedia
        ? quotedMessage
        : null;
    if (mediaMessage && this.options.mediaIngestion) {
      try {
        const media = await mediaMessage.downloadMedia();
        if (!media) throw new Error("WhatsApp returned no attachment data");
        attachments.push(
          await this.options.mediaIngestion.ingest({
            mimeType: media.mimetype,
            dataBase64: media.data,
            ...(media.filename != null ? { fileName: media.filename } : {}),
            ...(media.filesize != null ? { sizeBytes: media.filesize } : {}),
          }),
        );
      } catch (error) {
        this.options.logger.warn(
          { error, messageId },
          "Could not ingest WhatsApp attachment",
        );
        await this.client.sendMessage(
          groupId,
          "I couldn't process that attachment. Check the media-size limit and configure a transcription model for voice notes.",
        );
        return;
      }
    }

    try {
      const reply = await this.options.assistant.respond({
        groupId,
        groupName: chat?.name ?? groupId,
        messageId,
        requestedBy: author,
        requestedById: message.author || contact.id._serialized,
        body: prompt || message.body,
        quotedMessage: quotedMessage?.body ?? null,
        recentContext: this.options.context.get(groupId, true),
        attachments,
      });
      this.options.logger.info(
        { author, groupId, messageId, output: reply },
        `Sending ${this.options.botName} response`,
      );
      await this.sendCompleteMessage(groupId, reply);
    } catch (error) {
      this.options.logger.error({ error, messageId }, "Assistant request failed");
      const fallbackReply =
        "I hit an error while handling that. Please try again in a moment.";
      this.options.logger.info(
        { author, groupId, messageId, output: fallbackReply },
        `Sending ${this.options.botName} error response`,
      );
      await this.client.sendMessage(groupId, fallbackReply);
    }
  }

  private async sendCompleteMessage(groupId: string, output: string): Promise<void> {
    for (const chunk of splitWhatsAppMessage(output)) {
      await this.client.sendMessage(groupId, chunk);
    }
  }
}
