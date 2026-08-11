import { z } from "zod";
import type { Logger } from "./logger.js";
import type {
  AssistantAttachment,
  AssistantAttachmentKind,
} from "./types.js";

interface IncomingMedia {
  mimeType: string;
  dataBase64: string;
  fileName?: string | null;
  sizeBytes?: number | null;
}

interface MediaIngestionOptions {
  transcriptionUrl?: string;
  transcriptionLanguage: string;
  transcriptionTimeoutMs: number;
  maxBytes: number;
  logger: Logger;
}

const whisperResponseSchema = z.object({ text: z.string() });

function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

export function classifyMedia(mimeType: string): AssistantAttachmentKind {
  const mime = baseMimeType(mimeType);
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function defaultFileName(kind: AssistantAttachmentKind, mimeType: string): string {
  const extension = baseMimeType(mimeType).split("/")[1]?.replace(/[^a-z0-9]/g, "");
  return `whatsapp-${kind}.${extension || "bin"}`;
}

export class MediaIngestionService {
  public constructor(private readonly options: MediaIngestionOptions) {}

  public async ingest(input: IncomingMedia): Promise<AssistantAttachment> {
    const sizeBytes =
      input.sizeBytes ?? Buffer.from(input.dataBase64, "base64").byteLength;
    if (sizeBytes <= 0 || sizeBytes > this.options.maxBytes) {
      throw new RangeError(
        `Attachment is ${sizeBytes} bytes; the configured limit is ${this.options.maxBytes} bytes`,
      );
    }

    const mimeType = baseMimeType(input.mimeType);
    const kind = classifyMedia(mimeType);
    const fileName =
      input.fileName?.trim().replace(/[\\/]/g, "-") ||
      defaultFileName(kind, mimeType);
    let transcript: string | null = null;

    if (kind === "audio") {
      if (!this.options.transcriptionUrl) {
        throw new Error(
          "Voice transcription is disabled; configure WHISPER_TRANSCRIPTION_URL",
        );
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([Buffer.from(input.dataBase64, "base64")], { type: mimeType }),
        fileName,
      );
      form.append("response_format", "json");
      form.append("temperature", "0.0");
      form.append("language", this.options.transcriptionLanguage);
      const response = await fetch(this.options.transcriptionUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.options.transcriptionTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `Local Whisper returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      }
      transcript = whisperResponseSchema.parse(await response.json()).text.trim();
      if (!transcript) throw new Error("Local Whisper returned an empty transcript");
      this.options.logger.info(
        {
          language: this.options.transcriptionLanguage,
          transcriptCharacters: transcript.length,
        },
        "Transcribed WhatsApp voice attachment with local Whisper",
      );
    }

    return {
      kind,
      mimeType,
      fileName,
      dataBase64: input.dataBase64,
      sizeBytes,
      transcript,
    };
  }
}
