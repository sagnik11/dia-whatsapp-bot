import { vi } from "vitest";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../../src/d1-schema.js";
import { FollowUpStore } from "../../src/follow-up-store.js";
import type { CompletionRequest, CompletionResult } from "../../src/llm.js";
import { MemoryStore } from "../../src/memory-store.js";
import { INTEGRATIONS_SCHEMA_STATEMENTS, OutboundStore } from "../../src/outbound-store.js";
import { TaskStore } from "../../src/task-store.js";
import type { AssistantRequest } from "../../src/types.js";
import { createSqliteExecutor } from "./sqlite-executor.js";

export const testLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
export const NOW = "2026-11-04T06:30:00.000Z"; // Wednesday, 12:00 IST
export const googleCredentials = { clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh-secret" };

const open: Array<ReturnType<typeof createSqliteExecutor>> = [];

/** Closes every database opened by integrationStores; call from afterEach. */
export function closeIntegrationStores(): void {
  for (const executor of open.splice(0)) executor.close();
}

/** Real stores on in-memory SQLite: the ledger plus the Phase 1 stores prep_meeting reads. */
export async function integrationStores(now = NOW) {
  const db = createSqliteExecutor();
  open.push(db);
  const clock = () => new Date(now);
  const phase1 = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, testLogger, "Phase 1");
  await phase1.ensure();
  const schema = new SchemaGate(db, INTEGRATIONS_SCHEMA_STATEMENTS, testLogger, "Integrations");
  return {
    db,
    clock,
    ledger: new OutboundStore({ db, schema, logger: testLogger, now: clock }),
    tasks: new TaskStore({ db, timezone: "Asia/Kolkata", logger: testLogger, now: clock }),
    memory: new MemoryStore({ db, schema: phase1, logger: testLogger, now: clock }),
    followUps: new FollowUpStore({ db, schema: phase1, timezone: "Asia/Kolkata", logger: testLogger, now: clock }),
  };
}

/** A fake model that plays back turns and records each request it saw. */
export function scripted(...turns: CompletionResult[]) {
  const requests: CompletionRequest[] = [];
  const complete = vi.fn(async (request: CompletionRequest) => {
    requests.push({ ...request, messages: [...request.messages] });
    const next = turns.shift();
    if (!next) throw new Error("out of turns");
    return next;
  });
  return { complete, requests };
}

let counter = 0;

/** A founder's WhatsApp request; every call gets a fresh message id. */
export function founderRequest(body: string, extra: Partial<AssistantRequest> = {}): AssistantRequest {
  counter += 1;
  return {
    groupId: "g1",
    groupName: "HQ",
    messageId: `msg-${counter}`,
    requestedBy: "Sagnik",
    requestedById: "s@c.us",
    body,
    quotedMessage: null,
    recentContext: [],
    ...extra,
  };
}

/** Tool outputs fed back to the model across all recorded requests, as one string. */
export function toolOutputs(requests: readonly CompletionRequest[]): string {
  return JSON.stringify(requests.flatMap((entry) => entry.messages.filter((message) => message.role === "tool")));
}
