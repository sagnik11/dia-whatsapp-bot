import { describe, expect, it, vi } from "vitest";
import { MediaIngestionService, classifyMedia } from "../src/media-ingestion.js";

describe("media ingestion", () => {
  it("classifies supported WhatsApp attachment types", () => {
    expect(classifyMedia("audio/ogg; codecs=opus")).toBe("audio");
    expect(classifyMedia("image/jpeg")).toBe("image");
    expect(classifyMedia("application/pdf")).toBe("pdf");
    expect(classifyMedia("text/plain")).toBe("file");
  });

  it("normalizes a safe filename and calculates decoded size", async () => {
    const service = new MediaIngestionService({
      gatewayApiKey: "test-key",
      maxBytes: 100,
      logger: { info: vi.fn() } as never,
    });

    await expect(
      service.ingest({
        mimeType: "image/png",
        dataBase64: Buffer.from("image").toString("base64"),
        fileName: "folder\\screenshot.png",
      }),
    ).resolves.toMatchObject({
      kind: "image",
      fileName: "folder-screenshot.png",
      sizeBytes: 5,
      transcript: null,
    });
  });

  it("rejects oversized attachments before any model call", async () => {
    const service = new MediaIngestionService({
      gatewayApiKey: "test-key",
      maxBytes: 2,
      logger: { info: vi.fn() } as never,
    });

    await expect(
      service.ingest({
        mimeType: "application/pdf",
        dataBase64: Buffer.from("large").toString("base64"),
      }),
    ).rejects.toThrow("configured limit");
  });
});
