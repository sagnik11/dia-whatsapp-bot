import { z } from "zod";
import type { GoogleClient } from "./google-client.js";
import { parseResponse } from "./integration-http.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const SERVICE = "Gmail";

export interface EmailDraftInput {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
  /** Gmail thread id to reply in. */
  threadId: string | null;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

const headersSchema = z.array(z.object({ name: z.string(), value: z.string() })).default([]);
const draftSchema = z.object({
  id: z.string(),
  message: z.object({ id: z.string(), threadId: z.string().optional() }),
});
const sentSchema = z.object({ id: z.string(), threadId: z.string().optional() });
const threadSchema = z.object({
  messages: z.array(z.object({ payload: z.object({ headers: headersSchema }).optional() })).default([]),
});
const listSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
});
const metadataSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().default(""),
  payload: z.object({ headers: headersSchema }).optional(),
});

function header(headers: ReadonlyArray<{ name: string; value: string }>, name: string): string {
  return headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Strips line breaks (header injection) and RFC 2047-encodes non-ASCII text. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Builds the RFC 2822 message Gmail expects, as base64url. */
export function buildRawEmail(
  input: EmailDraftInput & { from: string; inReplyTo: string | null; references: string | null },
): string {
  const lines = [
    `From: ${encodeHeader(input.from)}`,
    `To: ${input.to.map(encodeHeader).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(encodeHeader).join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${encodeHeader(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${encodeHeader(input.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    ...(Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) ?? []),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** Gmail REST calls Patch needs: create and send drafts, and read-only search. */
export class GmailClient {
  public constructor(
    private readonly google: GoogleClient,
    private readonly accountEmail: string,
  ) {}

  public async createDraft(input: EmailDraftInput): Promise<{ draftId: string; messageId: string; threadId: string | null }> {
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (input.threadId) {
      const thread = parseResponse(
        SERVICE,
        threadSchema,
        await this.google.request(
          SERVICE,
          `${GMAIL}/threads/${encodeURIComponent(input.threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
        ),
      );
      const last = thread.messages.at(-1)?.payload?.headers ?? [];
      inReplyTo = header(last, "Message-ID") || null;
      references = [header(last, "References"), inReplyTo].filter(Boolean).join(" ") || null;
    }
    const raw = buildRawEmail({ ...input, from: this.accountEmail, inReplyTo, references });
    const draft = parseResponse(
      SERVICE,
      draftSchema,
      await this.google.request(SERVICE, `${GMAIL}/drafts`, {
        method: "POST",
        body: { message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
      }),
    );
    return { draftId: draft.id, messageId: draft.message.id, threadId: draft.message.threadId ?? null };
  }

  /** Sends an existing draft. Only the send_email tool calls this, after the go-ahead guard. */
  public async sendDraft(draftId: string): Promise<{ messageId: string; threadId: string | null }> {
    const sent = parseResponse(
      SERVICE,
      sentSchema,
      await this.google.request(SERVICE, `${GMAIL}/drafts/send`, { method: "POST", body: { id: draftId } }),
    );
    return { messageId: sent.id, threadId: sent.threadId ?? null };
  }

  /** Read-only search with Gmail query syntax ("from:rahul newer_than:7d"). */
  public async search(query: string, max: number): Promise<EmailSummary[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(max) });
    const list = parseResponse(
      SERVICE,
      listSchema,
      await this.google.request(SERVICE, `${GMAIL}/messages?${params.toString()}`),
    );
    return Promise.all(
      list.messages.slice(0, max).map(async ({ id }) => {
        const message = parseResponse(
          SERVICE,
          metadataSchema,
          await this.google.request(
            SERVICE,
            `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        );
        const headers = message.payload?.headers ?? [];
        return {
          id: message.id,
          threadId: message.threadId,
          from: header(headers, "From"),
          subject: header(headers, "Subject"),
          date: header(headers, "Date"),
          snippet: decodeEntities(message.snippet).slice(0, 300),
        };
      }),
    );
  }
}
