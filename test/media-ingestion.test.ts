import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaIngestionService, classifyMedia } from "../src/media-ingestion.js";

afterEach(() => vi.unstubAllGlobals());

describe("media ingestion", () => {
  it("classifies supported WhatsApp attachment types", () => {
    expect(classifyMedia("audio/ogg; codecs=opus")).toBe("audio");
    expect(classifyMedia("image/jpeg")).toBe("image");
    expect(classifyMedia("application/pdf")).toBe("pdf");
    expect(classifyMedia("text/plain")).toBe("file");
  });

  it("normalizes a safe filename and calculates decoded size", async () => {
    const service = new MediaIngestionService({
      transcriptionLanguage: "auto",
      transcriptionTimeoutMs: 10_000,
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
      transcriptionLanguage: "auto",
      transcriptionTimeoutMs: 10_000,
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

  it("transcribes voice notes through the private local Whisper endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "  Ship the release tomorrow.  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new MediaIngestionService({
      transcriptionUrl: "http://whisper:8080/inference",
      transcriptionLanguage: "auto",
      transcriptionTimeoutMs: 10_000,
      maxBytes: 100,
      logger: { info: vi.fn() } as never,
    });

    await expect(
      service.ingest({
        mimeType: "audio/ogg; codecs=opus",
        dataBase64: Buffer.from("voice").toString("base64"),
        fileName: "voice.ogg",
      }),
    ).resolves.toMatchObject({
      kind: "audio",
      transcript: "Ship the release tomorrow.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://whisper:8080/inference",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });
});
