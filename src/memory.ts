import { createHash } from "node:crypto";
import Supermemory from "supermemory";
import type { Logger } from "./logger.js";
import type { AssistantRequest, RecalledMemory } from "./types.js";

interface AutterMemoryServiceOptions {
  apiKey: string;
  baseUrl: string;
  containerTag: string;
  recallLimit: number;
  recallThreshold: number;
  timeoutMs: number;
  logger: Logger;
}

export function exactExchangeContent(
  request: AssistantRequest,
  reply: string,
  rawFounderMessage = request.body,
): string {
  const attachmentLines = (request.attachments ?? []).flatMap(
    (attachment, index) => [
      `Attachment ${index + 1}: ${attachment.fileName} (${attachment.kind}, ${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
      attachment.transcript
        ? `Attachment ${index + 1} transcript:\n${attachment.transcript}`
        : null,
    ],
  );

  return [
    "Authorized WhatsApp exchange addressed to Captain Patch",
    `Recorded at: ${new Date().toISOString()}`,
    `Group: ${request.groupName}`,
    `Founder: ${request.requestedBy}`,
    `Founder WhatsApp ID: ${request.requestedById}`,
    "",
    "Founder message:",
    rawFounderMessage,
    ...(request.quotedMessage
      ? ["", "Quoted message included by the founder:", request.quotedMessage]
      : []),
    ...(attachmentLines.length > 0
      ? ["", "Attachments explicitly sent or quoted with the command:", ...attachmentLines]
      : []),
    "",
    "Captain Patch reply:",
    reply,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function memoryText(result: {
  memory?: string;
  chunk?: string;
}): string | null {
  const value = result.memory ?? result.chunk;
  return value?.trim() || null;
}

export class AutterMemoryService {
  private readonly client: Supermemory;

  public constructor(private readonly options: AutterMemoryServiceOptions) {
    this.client = new Supermemory({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      maxRetries: 1,
    });
  }

  public async recall(request: AssistantRequest): Promise<RecalledMemory | null> {
    try {
      const [profile, search] = await Promise.all([
        this.client.profile({
          containerTag: this.options.containerTag,
        }),
        this.client.search({
          q: [request.body, request.quotedMessage].filter(Boolean).join("\n"),
          containerTag: this.options.containerTag,
          limit: this.options.recallLimit,
          threshold: this.options.recallThreshold,
          searchMode: "hybrid",
          rerank: true,
        }),
      ]);
      const recalled = {
        staticProfile: profile.profile.static,
        dynamicProfile: profile.profile.dynamic,
        relevantMemories: search.results
          .map(memoryText)
          .filter((value): value is string => Boolean(value)),
      };
      this.options.logger.info(
        {
          messageId: request.messageId,
          staticProfileCount: recalled.staticProfile.length,
          dynamicProfileCount: recalled.dynamicProfile.length,
          relevantMemoryCount: recalled.relevantMemories.length,
        },
        "Recalled Autter memory",
      );
      return recalled;
    } catch (error) {
      this.options.logger.warn(
        { error, messageId: request.messageId },
        "Autter memory recall failed; continuing without recalled memory",
      );
      return null;
    }
  }

  public async rememberExchange(
    request: AssistantRequest,
    reply: string,
    rawFounderMessage = request.body,
  ): Promise<void> {
    const customId = `whatsapp-${createHash("sha256")
      .update(request.messageId)
      .digest("hex")}`;
    try {
      const result = await this.client.add({
        content: exactExchangeContent(request, reply, rawFounderMessage),
        containerTag: this.options.containerTag,
        customId,
        taskType: "memory",
        entityContext:
          "Autter.dev is the startup co-founded equally by Sagnik Ghosh and Tanvi Bhole. Captain Patch is Autter's shared WhatsApp assistant. Preserve founder statements, decisions, preferences, plans, corrections, and historical context with their authors and dates.",
        metadata: {
          source: "whatsapp",
          sourceMessageId: request.messageId,
          groupId: request.groupId,
          groupName: request.groupName,
          founderName: request.requestedBy,
          founderId: request.requestedById,
          hasQuotedMessage: Boolean(request.quotedMessage),
          attachmentCount: request.attachments?.length ?? 0,
        },
      });
      this.options.logger.info(
        {
          messageId: request.messageId,
          memoryDocumentId: result.id,
          status: result.status,
        },
        "Queued complete Patch exchange in Autter memory",
      );
    } catch (error) {
      this.options.logger.warn(
        { error, messageId: request.messageId },
        "Could not persist Patch exchange in Autter memory",
      );
    }
  }
}
