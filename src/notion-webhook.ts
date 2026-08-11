import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { verifyWebhookSignature } from "@notionhq/client";
import { z } from "zod";
import type { DedupeStore } from "./dedupe-store.js";
import type { Logger } from "./logger.js";
import type { NotionTaskService } from "./notion.js";

type SendMessage = (groupId: string, message: string) => Promise<void>;

interface NotionWebhookServerOptions {
  port: number;
  path: string;
  verificationToken?: string;
  notificationGroupIds: ReadonlySet<string>;
  notifyBotEvents: boolean;
  notion: NotionTaskService;
  dedupe: DedupeStore;
  send: SendMessage;
  logger: Logger;
}

const authorSchema = z.object({
  id: z.string(),
  type: z.enum(["person", "bot"]),
});

const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  authors: z.array(authorSchema).default([]),
  entity: z.object({ id: z.string(), type: z.string() }),
  data: z
    .object({ page_id: z.string().optional() })
    .passthrough()
    .optional(),
});

const handshakeSchema = z.object({ verification_token: z.string().min(1) });
type NotionEvent = z.infer<typeof eventSchema>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new RangeError("Webhook body exceeds 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function taskDetails(task: Awaited<ReturnType<NotionTaskService["getTaskById"]>>): string {
  if (!task) return "";
  const details = [
    task.status ? `status: ${task.status}` : null,
    task.assignees.length > 0 ? `assigned: ${task.assignees.join(", ")}` : null,
    task.dueAt ? `due: ${task.dueAt}` : null,
  ].filter(Boolean);
  return details.length > 0 ? `\n${details.join(" · ")}` : "";
}

export async function notionEventNotification(
  event: NotionEvent,
  notion: NotionTaskService,
  notifyBotEvents: boolean,
): Promise<string | null> {
  if (!notifyBotEvents && event.authors.some((author) => author.type === "bot")) {
    return null;
  }

  if (
    ["page.created", "page.properties_updated", "page.content_updated"].includes(
      event.type,
    )
  ) {
    const task = await notion.getTaskById(event.entity.id);
    if (!task) return null;
    const action =
      event.type === "page.created"
        ? "created"
        : event.type === "page.content_updated"
          ? "had its page content updated"
          : "was updated";
    return `🧭 Notion watch: *${task.title}* ${action}.${taskDetails(task)}`;
  }

  if (["comment.created", "comment.updated"].includes(event.type)) {
    const pageId = event.data?.page_id;
    if (!pageId) return null;
    const task = await notion.getTaskById(pageId);
    if (!task) return null;
    const comment = await notion.getTaskComment(event.entity.id);
    if (!comment) return null;
    const action = event.type === "comment.created" ? "commented" : "updated a comment";
    const text = comment.text.replace(/\s+/g, " ").trim().slice(0, 700);
    return `💬 ${comment.author} ${action} on *${task.title}*:\n${text || "(empty comment)"}`;
  }

  return null;
}

export class NotionWebhookServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });

  public constructor(private readonly options: NotionWebhookServerOptions) {}

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "0.0.0.0", () => {
        this.server.off("error", reject);
        this.options.logger.info(
          { port: this.options.port, path: this.options.path },
          "Notion webhook receiver is listening",
        );
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST" || pathname !== this.options.path) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const rawBody = await readBody(request);
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      const handshake = handshakeSchema.safeParse(parsed);
      if (handshake.success) {
        if (!this.options.verificationToken) {
          this.options.logger.warn(
            { verificationToken: handshake.data.verification_token },
            "Notion webhook verification token received; copy it to NOTION_WEBHOOK_VERIFICATION_TOKEN and restart",
          );
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (!this.options.verificationToken) {
        sendJson(response, 503, { error: "verification_token_not_configured" });
        return;
      }
      const signature = request.headers["x-notion-signature"];
      const verified = await verifyWebhookSignature({
        body: rawBody,
        signature: Array.isArray(signature) ? signature[0] : signature,
        verificationToken: this.options.verificationToken,
      });
      if (!verified) {
        sendJson(response, 401, { error: "invalid_signature" });
        return;
      }

      const event = eventSchema.parse(parsed);
      const dedupeKey = `notion_webhook:${event.id}`;
      if (this.options.dedupe.has(dedupeKey)) {
        sendJson(response, 200, { ok: true, duplicate: true });
        return;
      }
      const notification = await notionEventNotification(
        event,
        this.options.notion,
        this.options.notifyBotEvents,
      );
      if (notification) {
        for (const groupId of this.options.notificationGroupIds) {
          await this.options.send(groupId, notification);
        }
      }
      this.options.dedupe.claim(dedupeKey);
      this.options.logger.info(
        { eventId: event.id, eventType: event.type, notified: Boolean(notification) },
        "Processed Notion webhook event",
      );
      sendJson(response, 200, { ok: true });
    } catch (error) {
      this.options.logger.error({ error }, "Failed to process Notion webhook");
      sendJson(
        response,
        error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 503,
        { error: "webhook_processing_failed" },
      );
    }
  }
}
