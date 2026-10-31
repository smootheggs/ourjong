import { describe, expect, it } from "vitest";
import { RoomManager } from "./room.ts";
import { EMOJI_COOLDOWN_MS, QUICK_EMOJIS, registerSocketHandlers } from "./socket.ts";
import type { OurjongServer } from "./socket.ts";

/** Just enough of Socket.io to drive the handlers: sockets, rooms (channels) and emits. */
function fakeIo() {
  type Handler = (...args: unknown[]) => void;
  const connection: Handler[] = [];
  const members = new Map<string, Set<string>>();
  const sockets = new Map<string, FakeSocket>();
  class FakeSocket {
    readonly handlers = new Map<string, Handler>();
    readonly received: { event: string; data: unknown }[] = [];
    readonly handshake = { address: "127.0.0.1", headers: {} };
    constructor(readonly id: string) {}
    on(event: string, fn: Handler) { this.handlers.set(event, fn); return this; }
    once(event: string, fn: Handler) { this.handlers.set(event, fn); return this; }
    emit(event: string, data?: unknown) { this.received.push({ event, data }); return true; }
    join(channel: string) { (members.get(channel) ?? members.set(channel, new Set()).get(channel)!).add(this.id); }
    leave(channel: string) { members.get(channel)?.delete(this.id); }
    disconnect() {}
    /** Everyone in the channel except me. */
    to(channel: string) {
      return { emit: (event: string, data: unknown) => {
        for (const id of members.get(channel) ?? []) if (id !== this.id) sockets.get(id)!.emit(event, data);
      } };
    }
    send(event: string, payload?: unknown) { this.handlers.get(event)!(payload); }
    heard(event: string) { return this.received.filter((r) => r.event === event).map((r) => r.data); }
  }
  const io = {
    use: () => io,
    on: (_e: string, fn: Handler) => { connection.push(fn); },
    to: (id: string) => ({ emit: (event: string, data: unknown) => sockets.get(id)?.emit(event, data) }),
    sockets: { sockets },
  };
  const connect = (id: string) => {
    const s = new FakeSocket(id);
    sockets.set(id, s);
    connection.forEach((fn) => fn(s));
    return s;
  };
  return { io: io as unknown as OurjongServer, connect };
}

function table() {
  let now = 1_000_000;
  const rooms = new RoomManager({ now: () => now });
  const { io, connect } = fakeIo();
  registerSocketHandlers(io, rooms, { maxConnectionsPerIp: 0 });
  const players = ["a", "b", "c", "d"].map((id) => {
    const s = connect(id);
    s.send("join_room", { code: "ABCD", name: id });
    return s;
  });
  return { players, advance: (ms: number) => { now += ms; } };
}

describe("chat_emoji", () => {
  it("reaches the other three players with the sender's seat, and not the sender", () => {
    const { players } = table();
    players[2]!.send("chat_emoji", { emoji: "👏" });
    const got = players.map((p) => p.heard("chat_emoji"));
    expect(got[2]).toEqual([]);
    for (const i of [0, 1, 3]) {
      expect(got[i]).toHaveLength(1);
      expect(got[i]![0]).toMatchObject({ seat: 2, emoji: "👏" });
    }
  });

  it("refuses anything that is not on the list", () => {
    const { players } = table();
    for (const bad of ["hello", "<b>x</b>", "👏👏", 7, null, {}, { emoji: 5 }, { emoji: "😈" }]) {
      players[0]!.send("chat_emoji", bad);
    }
    expect(players[1]!.heard("chat_emoji")).toEqual([]);
    expect(players[0]!.heard("action_error").length).toBeGreaterThan(0);
  });

  it("ignores a second emoji from the same player inside the cooldown", () => {
    const { players } = table();
    players[0]!.send("chat_emoji", { emoji: QUICK_EMOJIS[0] });
    players[0]!.send("chat_emoji", { emoji: QUICK_EMOJIS[1] });
    expect(players[1]!.heard("chat_emoji")).toHaveLength(1);
  });

  it("does nothing for a socket that has not joined a room", () => {
    const { io, connect } = fakeIo();
    registerSocketHandlers(io, new RoomManager(), { maxConnectionsPerIp: 0 });
    const lone = connect("z");
    lone.send("chat_emoji", { emoji: "👋" });
    expect(lone.heard("action_error")).toHaveLength(1);
  });

  it("exports a cooldown", () => {
    expect(EMOJI_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
