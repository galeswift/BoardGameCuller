import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game } from "@/lib/model";

const h = vi.hoisted(() => ({
  signedIn: true,
  token: "",
  pool: null as unknown,
  fetchBgg: null as unknown as (username: string, previous: Game[]) => Promise<Game[]>,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.signedIn ? { value: h.token } : undefined) }),
}));
vi.mock("@/db", async (original) => ({ ...(await original<object>()), getDb: async () => h.pool }));
vi.mock("@/lib/bgg", async (original) => ({
  ...(await original<object>()),
  fetchBggCollection: (u: string, p: Game[]) => h.fetchBgg(u, p),
}));

import { sessionToken } from "@/app/auth";
import { GET, POST } from "@/app/api/state/route";
import { POST as importBgg } from "@/app/api/bgg/route";
import { BggError } from "@/lib/bgg";
import { defaults } from "@/lib/model";
import seed from "@/lib/collection.json";
import { apiRequest, createTestDb, game } from "./helpers";

const load = async (profile?: string) => {
  const res = await GET(apiRequest(`/api/state${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`));
  return { status: res.status, body: await res.json() };
};
const save = async (body: unknown, origin?: string) => {
  const res = await POST(apiRequest("/api/state", { method: "POST", body, origin }));
  return { status: res.status, body: await res.json() };
};

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { db = await createTestDb(); h.pool = db.pool; });

beforeEach(async () => {
  await db.pg.exec("TRUNCATE collection_state, preferences");
  h.signedIn = true;
  h.token = sessionToken()!;
  h.fetchBgg = async () => [game("1"), game("2")];
});

describe("auth and request checks", () => {
  it("requires sign-in", async () => {
    h.signedIn = false;
    expect((await load()).status).toBe(401);
    expect((await save({ action: "settings", patch: { target: 5 } })).status).toBe(401);
    expect((await importBgg(apiRequest("/api/bgg", { method: "POST", body: {} }))).status).toBe(401);
  });

  it("rejects cross-site writes", async () => {
    expect((await save({ action: "settings", patch: { target: 5 } }, "https://evil.example")).status).toBe(403);
    expect((await importBgg(apiRequest("/api/bgg", { method: "POST", body: {}, origin: "https://evil.example" }))).status).toBe(403);
  });

  it("rejects invalid profile names", async () => {
    expect((await load("../etc")).status).toBe(400);
    expect((await save({ profile: "<x>", action: "settings", patch: { target: 5 } })).status).toBe(400);
  });

  it("rejects unknown actions and invalid payloads", async () => {
    expect((await save({ action: "drop" })).body.error).toBe("Unknown action.");
    expect((await save({ action: "preference", id: "abc", patch: { thumb: 1 } })).status).toBe(400);
  });
});

describe("profiles", () => {
  it("serves the bundled collection to the default profile", async () => {
    const { body } = await load();
    expect(body.profile).toBe("galeswift");
    expect(body.games).toHaveLength(seed.length);
    expect(body.settings).toEqual(defaults);
    expect(body.savedAt).toBeNull();
  });

  it("starts other profiles empty and keeps their data separate", async () => {
    expect((await load("Friend")).body).toMatchObject({ profile: "friend", games: [], preferences: {} });

    await save({ profile: "friend", action: "collection", games: [game("10")] });
    await save({ profile: "friend", action: "preference", id: "10", patch: { thumb: -1 } });
    await save({ action: "preference", id: "10", patch: { thumb: 1 } });

    const friend = (await load("friend")).body, me = (await load()).body;
    expect(friend.games.map((g: Game) => g.id)).toEqual(["10"]);
    expect(friend.preferences).toEqual({ "10": { thumb: -1 } });
    expect(me.preferences).toEqual({ "10": { thumb: 1 } });
    expect(me.games).toHaveLength(seed.length);
    expect(me.profiles).toEqual(["friend"]);
  });
});

describe("saving", () => {
  it("merges preference patches key by key", async () => {
    await save({ action: "preference", id: "5", patch: { thumb: 1, notes: "a" } });
    await save({ action: "preference", id: "5", patch: { mustKeep: true, notes: "b" } });
    await save({ action: "preference", id: "5", patch: { box: null } });
    expect((await load()).body.preferences["5"]).toEqual({ thumb: 1, mustKeep: true, notes: "b", box: null });
  });

  it("merges settings over the defaults", async () => {
    await save({ action: "settings", patch: { target: 50 } });
    await save({ action: "settings", patch: { preserve: false } });
    expect((await load()).body.settings).toEqual({ ...defaults, target: 50, preserve: false });
  });

  it("replacing the collection keeps settings and preferences", async () => {
    await save({ action: "settings", patch: { target: 3 } });
    await save({ action: "preference", id: "1", patch: { thumb: 1 } });
    const { body } = await save({ action: "collection", games: [game("1"), game("2")] });
    expect(body.savedAt).toEqual(expect.any(String));
    const state = (await load()).body;
    expect(state.games).toHaveLength(2);
    expect(state.settings.target).toBe(3);
    expect(state.preferences["1"]).toEqual({ thumb: 1 });
  });

  it("restores a backup, replacing earlier preferences", async () => {
    await save({ action: "preference", id: "1", patch: { thumb: 1 } });
    await save({
      action: "restore",
      backup: { format: "collection-cull-v1", games: [game("7")], settings: { target: 1 }, preferences: { "7": { mustKeep: true }, "8": {} } },
    });
    const state = (await load()).body;
    expect(state.games.map((g: Game) => g.id)).toEqual(["7"]);
    expect(state.preferences).toEqual({ "7": { mustKeep: true } });
    expect(state.settings.target).toBe(1);
  });

  it("rejects a backup in the wrong format without touching data", async () => {
    await save({ action: "preference", id: "1", patch: { thumb: 1 } });
    expect((await save({ action: "restore", backup: { format: "other" } })).status).toBe(400);
    expect((await load()).body.preferences).toEqual({ "1": { thumb: 1 } });
  });
});

describe("BGG import route", () => {
  const sync = async (profile?: string) => {
    const res = await importBgg(apiRequest("/api/bgg", { method: "POST", body: { profile } }));
    return { status: res.status, body: await res.json() };
  };

  it("imports into the requested profile and passes its previous games", async () => {
    const calls: [string, Game[]][] = [];
    h.fetchBgg = async (u, prev) => { calls.push([u, prev]); return [game("1", { group: "kept" })]; };

    expect((await sync("Friend")).status).toBe(200);
    expect(calls[0]).toEqual(["friend", []]);
    expect((await load("friend")).body.games).toEqual([game("1", { group: "kept" })]);

    await sync("friend");
    expect(calls[1][1]).toEqual([game("1", { group: "kept" })]);
  });

  it("gives the default profile the bundled collection as its starting point", async () => {
    let previous: Game[] = [];
    h.fetchBgg = async (_u, prev) => { previous = prev; return [game("1")]; };
    await sync();
    expect(previous).toHaveLength(seed.length);
  });

  it("passes BGG errors through and leaves data untouched", async () => {
    h.fetchBgg = async () => { throw new BggError("BoardGameGeek doesn’t recognise that username."); };
    expect(await sync("nobody")).toEqual({ status: 502, body: { error: "BoardGameGeek doesn’t recognise that username." } });
    expect((await load("nobody")).body.games).toEqual([]);
  });

  it("validates what BGG returned before saving", async () => {
    h.fetchBgg = async () => [game("1"), game("1")];
    expect((await sync("friend")).status).toBe(503);
    expect((await load("friend")).body.games).toEqual([]);
  });
});
