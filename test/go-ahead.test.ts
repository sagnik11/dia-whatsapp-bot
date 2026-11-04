import { describe, expect, it } from "vitest";
import {
  checkGoAhead,
  goAheadInstructions,
  namedRefs,
  parseOutboundRef,
  stripQuotedText,
} from "../src/go-ahead.js";

const none = new Set<number>();

function send(body: string, id = 12, created: ReadonlySet<number> = none) {
  return checkGoAhead({ kind: "email", id, body, createdThisRequest: created }).ok;
}

function book(body: string, id = 3, created: ReadonlySet<number> = none) {
  return checkGoAhead({ kind: "calendar", id, body, createdThisRequest: created }).ok;
}

describe("go-ahead guard", () => {
  it("parses refs of the right kind only", () => {
    expect(parseOutboundRef("E12", "email")).toBe(12);
    expect(parseOutboundRef("ev3", "calendar")).toBe(3);
    expect(parseOutboundRef(7, "email")).toBe(7);
    expect(parseOutboundRef("EV3", "email")).toBeNull();
    expect(parseOutboundRef("E0", "email")).toBeNull();
    expect([...namedRefs("send E3 and EV4, E12", "email")]).toEqual([3, 12]);
    expect([...namedRefs("book EV4", "calendar")]).toEqual([4]);
  });

  it("accepts explicit send instructions that name the ref", () => {
    expect(send("send E12")).toBe(true);
    expect(send("Looks good. Send E12 please")).toBe(true);
    expect(send("send E11 and E12")).toBe(true);
    expect(send("E12 is perfect, go ahead and send")).toBe(true);
    expect(send("E12 is perfect, send it")).toBe(true);
    expect(send("can you send E12?")).toBe(true);
  });

  it("needs the ref named unless it was drafted in this same request", () => {
    expect(send("send it")).toBe(false);
    expect(send("go ahead and send")).toBe(false);
    expect(send("send it", 12, new Set([12]))).toBe(true);
    expect(send("send E11", 12)).toBe(false);
    expect(send("send E11", 12, new Set([12]))).toBe(false);
  });

  it("ignores quoted text and messages without an instruction", () => {
    expect(send("")).toBe(false);
    expect(send("thanks Patch")).toBe(false);
    expect(send('Rahul wrote "send it" yesterday, what does E12 say?')).toBe(false);
    expect(send("> send E12\nwhat do you think?")).toBe(false);
    expect(send("he said 'send E12' but hold on")).toBe(false);
    expect(send("the draft says `send E12`")).toBe(false);
    expect(stripQuotedText("don't 'send E12' it's fine")).not.toContain("send E12");
  });

  it("refuses negated, deferred and questioning messages", () => {
    expect(send("don't send E12")).toBe(false);
    expect(send("do not send it yet, E12 needs edits")).toBe(false);
    expect(send("wait until Rahul confirms, then send E12")).toBe(false);
    expect(send("check the numbers before you send E12")).toBe(false);
    expect(send("did you send E12?")).toBe(false);
    expect(send("should we send E12?")).toBe(false);
    expect(send("send E12?")).toBe(false);
    expect(send("send E12 to me first")).toBe(false);
    expect(send("send E12 tomorrow")).toBe(false);
    expect(send("send E12 at 5pm")).toBe(false);
    expect(send("Did you send E12? Never mind. Send E12 now.")).toBe(true);
  });

  it("applies the same rules to booking", () => {
    expect(book("book EV3")).toBe(true);
    expect(book("book it")).toBe(false);
    expect(book("book it", 3, new Set([3]))).toBe(true);
    expect(book("EV3 works for both of us, go ahead and book")).toBe(true);
    expect(book("book the meeting EV3")).toBe(true);
    expect(book("send EV3")).toBe(false);
    expect(book("book EV3 for Friday instead")).toBe(false);
    expect(book("don't book EV3")).toBe(false);
    expect(send("book E12")).toBe(false);
    expect(goAheadInstructions("book EV3 and EV4", "calendar")[0]?.refs).toEqual(new Set([3, 4]));
  });

  it("explains what the founder has to say", () => {
    const decision = checkGoAhead({ kind: "email", id: 12, body: "send it", createdThisRequest: none });
    expect(decision).toEqual({ ok: false, reason: expect.stringContaining('say "send E12"') });
  });
});
