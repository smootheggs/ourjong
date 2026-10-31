import { describe, expect, it } from "vitest";
import { LIMITS, RateLimiter, parseActionPayload, parseJoinPayload } from "./socket.ts";
import { RoomError } from "./room.ts";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof RoomError ? error.code : "other";
  }
  return "no error";
};

describe("parseJoinPayload", () => {
  it("accepts a code, a name and a token", () => {
    expect(parseJoinPayload({ code: "ABCD", name: "Ann", token: "abc_123-XYZ" })).toEqual({
      code: "ABCD",
      name: "Ann",
      token: "abc_123-XYZ",
    });
    expect(parseJoinPayload({ code: " ab cd " })).toEqual({ code: " ab cd " });
  });

  it("rejects things that are not a plain object", () => {
    for (const bad of [null, undefined, "ABCD", 42, [], [{ code: "ABCD" }], () => 1]) {
      expect(codeOf(() => parseJoinPayload(bad))).toBe("bad_payload");
    }
  });

  it("rejects unknown keys", () => {
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", admin: true }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", __proto__x: 1 }))).toBe("bad_payload");
  });

  it("caps the code", () => {
    expect(codeOf(() => parseJoinPayload({ code: "A".repeat(LIMITS.codeChars + 1) }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "AB1D" }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: 1234 }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({}))).toBe("bad_payload");
  });

  it("caps the name and strips invisible characters", () => {
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", name: "x".repeat(LIMITS.nameChars + 1) }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", name: 5 }))).toBe("bad_payload");
    expect(parseJoinPayload({ code: "ABCD", name: "A​n‮n\u0000a" }).name).toBe("Anna");
  });

  it("validates the token's length and alphabet", () => {
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", token: "x".repeat(LIMITS.tokenChars + 1) }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", token: "bad token!" }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", token: "" }))).toBe("bad_payload");
    expect(codeOf(() => parseJoinPayload({ code: "ABCD", token: { $ne: 1 } }))).toBe("bad_payload");
  });
});

describe("parseActionPayload", () => {
  it("reduces tiles to their ids and drops everything else the client attached", () => {
    const clean = parseActionPayload({
      type: "discard",
      seq: 7,
      seat: 2,
      timestamp: 1,
      fromDraw: true,
      tile: { id: 33, face: { kind: "dragon", dragon: "red" }, evil: "x" },
      extra: "ignored",
    });
    expect(clean).toEqual({ type: "discard", seq: 7, seat: 2, tile: { id: 33 } });
  });

  it("handles every action type", () => {
    expect(parseActionPayload({ type: "draw", seq: 0, seat: 0, tile: {} })).toEqual({ type: "draw", seq: 0, seat: 0 });
    expect(parseActionPayload({ type: "pass", seq: 1, seat: 3 })).toEqual({ type: "pass", seq: 1, seat: 3 });
    expect(parseActionPayload({ type: "win", seq: 2, seat: 1, method: "self-draw", winningTile: { id: 4 } })).toEqual({
      type: "win",
      seq: 2,
      seat: 1,
      method: "self-draw",
    });
    expect(
      parseActionPayload({ type: "claim", seq: 3, seat: 1, payload: { kind: "pung", usingTiles: [{ id: 1, x: 1 }, { id: 2 }] } }),
    ).toEqual({ type: "claim", seq: 3, seat: 1, payload: { kind: "pung", usingTiles: [{ id: 1 }, { id: 2 }] } });
    expect(parseActionPayload({ type: "claim", seq: 3, seat: 1, payload: { kind: "win" } })).toEqual({
      type: "claim",
      seq: 3,
      seat: 1,
      payload: { kind: "win", usingTiles: [] },
    });
    expect(parseActionPayload({ type: "kong", seq: 4, seat: 0, variant: "concealed", tiles: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] })).toMatchObject({
      variant: "concealed",
    });
    expect(parseActionPayload({ type: "system", seq: 9, event: "round-advance" })).toEqual({
      type: "system",
      seq: 9,
      event: "round-advance",
    });
  });

  it("rejects bad sequence numbers and seats", () => {
    for (const seq of [-1, 1.5, NaN, Infinity, "3", null, LIMITS.maxSeq + 1]) {
      expect(codeOf(() => parseActionPayload({ type: "pass", seq, seat: 0 }))).toBe("bad_payload");
    }
    for (const seat of [-1, 4, 0.5, "0", undefined]) {
      expect(codeOf(() => parseActionPayload({ type: "pass", seq: 0, seat }))).toBe("bad_payload");
    }
  });

  it("rejects unknown types and the system events clients may not send", () => {
    for (const type of ["hack", "hand-start", "", 5, undefined]) {
      expect(codeOf(() => parseActionPayload({ type, seq: 0, seat: 0 }))).toBe("bad_payload");
    }
    expect(codeOf(() => parseActionPayload({ type: "system", seq: 0, event: "hand-start" }))).toBe("bad_payload");
  });

  it("rejects malformed tiles and over-long tile lists", () => {
    const base = { type: "discard", seq: 0, seat: 0 };
    for (const tile of [undefined, null, 5, "x", { id: -1 }, { id: 1.5 }, { id: "3" }, { id: LIMITS.maxTileId + 1 }, []]) {
      expect(codeOf(() => parseActionPayload({ ...base, tile }))).toBe("bad_payload");
    }
    const five = Array.from({ length: 5 }, (_, id) => ({ id }));
    expect(codeOf(() => parseActionPayload({ type: "kong", seq: 0, seat: 0, variant: "concealed", tiles: five }))).toBe("bad_payload");
    expect(codeOf(() => parseActionPayload({ type: "kong", seq: 0, seat: 0, variant: "concealed", tiles: [] }))).toBe("bad_payload");
    expect(codeOf(() => parseActionPayload({ type: "kong", seq: 0, seat: 0, variant: "exposed", tiles: [{ id: 1 }] }))).toBe("bad_payload");
    expect(codeOf(() => parseActionPayload({ type: "claim", seq: 0, seat: 0, payload: { kind: "pung", usingTiles: five } }))).toBe("bad_payload");
    expect(codeOf(() => parseActionPayload({ type: "claim", seq: 0, seat: 0, payload: { kind: "nope" } }))).toBe("bad_payload");
    expect(codeOf(() => parseActionPayload({ type: "win", seq: 0, seat: 0, method: "discard" }))).toBe("bad_payload");
  });

  it("rejects non-objects", () => {
    for (const bad of [null, undefined, "discard", 7, [], [{ type: "pass" }]]) {
      expect(codeOf(() => parseActionPayload(bad))).toBe("bad_payload");
    }
  });
});

describe("RateLimiter", () => {
  const T = 1_000_000;

  it("lets a burst of five through and drops the sixth", () => {
    const limiter = new RateLimiter(5, 5, 40, 10_000, T);
    const verdicts = Array.from({ length: 7 }, () => limiter.take(T));
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok", "ok", "drop", "drop"]);
  });

  it("refills at five messages per second", () => {
    const limiter = new RateLimiter(5, 5, 40, 10_000, T);
    for (let i = 0; i < 5; i++) limiter.take(T);
    expect(limiter.take(T + 100)).toBe("drop"); // half a token
    expect(limiter.take(T + 200)).toBe("ok"); // one token
    expect(limiter.take(T + 200)).toBe("drop");
    // After a long quiet spell the bucket is full again, but never beyond the burst.
    const verdicts = Array.from({ length: 7 }, () => limiter.take(T + 60_000));
    expect(verdicts.filter((v) => v === "ok")).toHaveLength(5);
  });

  it("allows a steady five per second indefinitely", () => {
    const limiter = new RateLimiter(5, 5, 40, 10_000, T);
    for (let i = 0; i < 100; i++) expect(limiter.take(T + i * 200)).toBe("ok");
  });

  it("kicks a socket that keeps hammering", () => {
    const limiter = new RateLimiter(5, 5, 10, 10_000, T);
    for (let i = 0; i < 5; i++) limiter.take(T);
    const verdicts = Array.from({ length: 10 }, () => limiter.take(T));
    expect(verdicts.slice(0, 9).every((v) => v === "drop")).toBe(true);
    expect(verdicts[9]).toBe("kick");
  });

  it("forgives drops that are spread out", () => {
    const limiter = new RateLimiter(5, 5, 10, 1_000, T);
    for (let i = 0; i < 5; i++) limiter.take(T);
    for (let i = 0; i < 9; i++) expect(limiter.take(T)).toBe("drop");
    // The window ends, the count starts again.
    expect(limiter.take(T + 1_001)).toBe("ok");
    for (let i = 0; i < 5; i++) limiter.take(T + 1_001);
    expect(limiter.take(T + 1_001)).toBe("drop");
  });
});
