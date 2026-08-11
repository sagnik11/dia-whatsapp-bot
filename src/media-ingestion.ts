import { createGateway, type GatewayTranscriptionModelId } from "@ai-sdk/gateway";
import { transcribe } from "ai";
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
  gatewayApiKey: string;
  transcriptionModel?: string;
  maxBytes: number;
  logger: Logger;
}

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
      if (!this.options.transcriptionModel) {
        throw new Error(
          "Voice transcription is disabled; configure AI_GATEWAY_TRANSCRIPTION_MODEL",
        );
      }
      const gateway = createGateway({ apiKey: this.options.gatewayApiKey });
      const result = await transcribe({
        model: gateway.transcriptionModel(
          this.options.transcriptionModel as GatewayTranscriptionModelId,
        ),
        audio: Buffer.from(input.dataBase64, "base64"),
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(90_000),
      });
      transcript = result.text.trim();
      this.options.logger.info(
        {
          durationInSeconds: result.durationInSeconds,
          language: result.language,
          transcriptCharacters: transcript.length,
        },
        "Transcribed WhatsApp voice attachment",
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
