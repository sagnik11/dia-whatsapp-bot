import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppBot } from "../src/bot.js";

class FakeWhatsAppClient extends EventEmitter {
  public readonly info = { wid: { _serialized: "919011775183@c.us" } };
  public readonly initialize = vi.fn(async () => undefined);
  public readonly destroy = vi.fn(async () => undefined);
}

function createBot(client: FakeWhatsAppClient, readyTimeoutMs = 25): WhatsAppBot {
  return new WhatsAppBot({
    assistant: {} as never,
    context: {} as never,
    dedupe: {} as never,
    allowedGroupIds: new Set(),
    authorizedUserIds: new Set(),
    unauthorizedReply: "Shoo.",
    botName: "Patch",
    botTrigger: "@patch",
    dataDir: ".data",
    listGroupsOnStart: false,
    readyTimeoutMs,
    client: client as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
  });
}

describe("WhatsAppBot startup readiness", () => {
  it("does not treat authentication alone as a usable connection", async () => {
    const client = new FakeWhatsAppClient();
    client.initialize.mockImplementationOnce(async () => {
      client.emit("authenticated");
    });

    await expect(createBot(client).start()).rejects.toThrow(
      "WhatsApp authenticated but did not become ready",
    );
  });

  it("starts only after WhatsApp emits ready", async () => {
    const client = new FakeWhatsAppClient();
    client.initialize.mockImplementationOnce(async () => {
      client.emit("authenticated");
      client.emit("ready");
    });

    await expect(createBot(client).start()).resolves.toBeUndefined();
  });
});
