import { z } from "zod";
import type { Logger } from "./logger.js";

const toMarkdownResponseSchema = z.object({
  success: z.boolean(),
  result: z
    .array(
      z
        .object({
          name: z.string().optional(),
          format: z.string(),
          data: z.string().optional(),
          error: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

export interface DocumentConverter {
  toMarkdown(input: {
    fileName: string;
    mimeType: string;
    data: Buffer;
  }): Promise<string>;
}

interface CloudflareMarkdownConverterOptions {
  accountId: string;
  apiToken: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger: Logger;
}

/**
 * Workers AI Markdown conversion (PDF, Office, HTML, CSV, …) so that open
 * models, which cannot read raw PDFs, still see document contents.
 */
export class CloudflareMarkdownConverter implements DocumentConverter {
  private readonly endpoint: string;

  public constructor(private readonly options: CloudflareMarkdownConverterOptions) {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/tomarkdown`;
  }

  public async toMarkdown(input: {
    fileName: string;
    mimeType: string;
    data: Buffer;
  }): Promise<string> {
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(input.data)], { type: input.mimeType }),
      input.fileName,
    );
    const response = await (this.options.fetch ?? fetch)(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiToken}` },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    const parsed = toMarkdownResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    const document = parsed.success ? parsed.data.result[0] : undefined;
    if (!response.ok || !parsed.success || !parsed.data.success || !document) {
      throw new Error(`Markdown conversion failed with HTTP ${response.status}`);
    }
    if (document.format === "error" || !document.data?.trim()) {
      throw new Error(document.error ?? "Markdown conversion returned no content");
    }
    this.options.logger.info(
      { fileName: input.fileName, characters: document.data.length },
      "Converted WhatsApp document to Markdown with Workers AI",
    );
    return document.data.trim();
  }
}
