import { describe, expect, it, vi } from "vitest";
import { AutterMemoryService, exactExchangeContent } from "../src/memory.js";
import type { AssistantRequest } from "../src/types.js";

const request: AssistantRequest = {
  groupId: "founders@g.us",
  groupName: "Autter Founders",
  messageId: "false_founders@g.us_message-1_sagnik@lid",
  requestedBy: "Sagnik Ghosh",
  requestedById: "sagnik@lid",
  body: "remember that Tanvi owns launch marketing",
  quotedMessage: "The launch needs a single owner.",
  recentContext: [
    {
      author: "Someone else",
      body: "This ambient group message was not addressed to Patch.",
      timestamp: 1,
    },
  ],
  attachments: [
    {
      kind: "audio",
      mimeType: "audio/ogg",
      fileName: "launch-note.ogg",
      dataBase64: "not-stored-in-memory",
      sizeBytes: 42,
      transcript: "Tanvi will own launch marketing from today.",
    },
  ],
};

function memoryService() {
  return new AutterMemoryService({
    apiKey: "sm_test",
    baseUrl: "http://memory.test:6767",
    containerTag: "autter-company",
    recallLimit: 12,
    recallThreshold: 0.35,
    timeoutMs: 20_000,
    logger: { info: vi.fn(), warn: vi.fn() } as never,
  });
}

describe("exactExchangeContent", () => {
  it("stores the complete addressed exchange without ambient group chatter or media bytes", () => {
    const content = exactExchangeContent(
      request,
      "Logged. Tanvi has the launch conch now.",
      "@patch remember that Tanvi owns launch marketing",
    );

    expect(content).toContain("@patch remember that Tanvi owns launch marketing");
    expect(content).toContain("The launch needs a single owner.");
    expect(content).toContain("Tanvi will own launch marketing from today.");
    expect(content).toContain("Logged. Tanvi has the launch conch now.");
    expect(content).not.toContain("ambient group message");
    expect(content).not.toContain("not-stored-in-memory");
  });
});

describe("AutterMemoryService", () => {
  it("recalls the shared profile and relevant history", async () => {
    const profile = vi.fn().mockResolvedValue({
      profile: {
        static: ["Sagnik and Tanvi co-founded Autter"],
        dynamic: ["Preparing the launch"],
      },
    });
    const search = vi.fn().mockResolvedValue({
      results: [
        { memory: "Tanvi owns launch marketing", similarity: 0.93 },
        { chunk: "The launch needs a single owner", similarity: 0.81 },
      ],
      total: 2,
      timing: 4,
    });
    const service = memoryService();
    Object.assign(service as unknown as { client: unknown }, {
      client: { profile, search },
    });

    await expect(service.recall(request)).resolves.toEqual({
      staticProfile: ["Sagnik and Tanvi co-founded Autter"],
      dynamicProfile: ["Preparing the launch"],
      relevantMemories: [
        "Tanvi owns launch marketing",
        "The launch needs a single owner",
      ],
    });
    expect(profile).toHaveBeenCalledWith({ containerTag: "autter-company" });
    expect(search).toHaveBeenCalledWith({
      q: "remember that Tanvi owns launch marketing\nThe launch needs a single owner.",
      containerTag: "autter-company",
      limit: 12,
      threshold: 0.35,
      searchMode: "hybrid",
      rerank: true,
    });
  });

  it("fails open when the memory server is unavailable", async () => {
    const warn = vi.fn();
    const service = new AutterMemoryService({
      apiKey: "sm_test",
      baseUrl: "http://memory.test:6767",
      containerTag: "autter-company",
      recallLimit: 12,
      recallThreshold: 0.35,
      timeoutMs: 20_000,
      logger: { info: vi.fn(), warn } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: {
        profile: vi.fn().mockRejectedValue(new Error("offline")),
        search: vi.fn().mockRejectedValue(new Error("offline")),
      },
    });

    await expect(service.recall(request)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("queues the exact exchange under a stable WhatsApp idempotency key", async () => {
    const add = vi.fn().mockResolvedValue({ id: "memory-doc", status: "queued" });
    const service = memoryService();
    Object.assign(service as unknown as { client: unknown }, {
      client: { add },
    });

    await service.rememberExchange(
      request,
      "Logged. Tanvi has the launch conch now.",
      "@patch remember that Tanvi owns launch marketing",
    );

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "@patch remember that Tanvi owns launch marketing",
        ),
        containerTag: "autter-company",
        customId: expect.stringMatching(/^whatsapp-[a-f0-9]{64}$/),
        taskType: "memory",
        metadata: expect.objectContaining({
          source: "whatsapp",
          sourceMessageId: request.messageId,
          founderName: "Sagnik Ghosh",
          attachmentCount: 1,
        }),
      }),
    );
  });
});
