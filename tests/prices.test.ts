import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { choose, estimate, fetchBggMarket, quotePrices, resetEbayToken, titleMatches } from "@/lib/prices";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const day = (iso: string) => new Date(iso).toUTCString();
const listing = (condition: string, price: string, date: string, currency = "USD") =>
  `<listing><listdate value="${day(date)}"/><price currency="${currency}" value="${price}"/><condition value="${condition}"/><notes value=""/></listing>`;
const marketXml = (items: Record<string, string[]>) =>
  `<?xml version="1.0" encoding="utf-8"?><items>${Object.entries(items)
    .map(([id, ls]) => `<item type="boardgame" id="${id}"><marketplacelistings>${ls.join("")}</marketplacelistings></item>`)
    .join("")}</items>`;
const xml = (body: string) => new Response(body, { status: 200 });

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
async function run<T>(promise: Promise<T>) {
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BGG_API_TOKEN", "token");
  vi.stubEnv("EBAY_CLIENT_ID", "");
  vi.stubEnv("EBAY_CLIENT_SECRET", "");
  resetEbayToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("estimate", () => {
  it("takes the median and range", () => {
    expect(estimate([{ price: 30 }, { price: 10 }, { price: 200 }], "bgg")).toMatchObject({ median: 30, low: 10, high: 200, count: 3 });
    expect(estimate([{ price: 10 }, { price: 21 }], "ebay")).toMatchObject({ median: 15.5, source: "ebay" });
    expect(estimate([], "bgg")).toBeNull();
  });

  it("records the listing date range", () => {
    const e = estimate([{ price: 5, date: Date.parse("2025-03-02") }, { price: 6, date: Date.parse("2024-01-09") }], "bgg");
    expect(e).toMatchObject({ since: "2024-01-09", until: "2025-03-02" });
  });
});

describe("choose", () => {
  const e = (count: number, source: "bgg" | "ebay" = "bgg") => ({ median: 1, low: 1, high: 1, count, source });
  it("prefers the first source with enough listings", () => {
    expect(choose(e(2), e(5, "ebay"), e(9))).toMatchObject({ count: 5, source: "ebay" });
    expect(choose(e(3), e(9, "ebay"))).toMatchObject({ count: 3, source: "bgg" });
  });
  it("otherwise takes the best-supported thin estimate", () => {
    expect(choose(e(1), null, e(2))).toMatchObject({ count: 2 });
    expect(choose(null, null)).toBeNull();
  });
});

describe("titleMatches", () => {
  it("needs every meaningful word of the game name", () => {
    expect(titleMatches("Wingspan Board Game - Stonemaier, complete", "Wingspan")).toBe(true);
    expect(titleMatches("The Castles of Burgundy board game", "Castles of Burgundy")).toBe(true);
    expect(titleMatches("Wings of Glory WW1", "Wingspan")).toBe(false);
  });
  it("rejects accessories and partial lots", () => {
    expect(titleMatches("Wingspan card sleeves 100 pack", "Wingspan")).toBe(false);
    expect(titleMatches("Wingspan organizer insert", "Wingspan")).toBe(false);
    expect(titleMatches("Wingspan European Expansion", "Wingspan")).toBe(false);
  });
  it("allows junk words that are part of the game's own name", () => {
    expect(titleMatches("Too Many Bones board game Chip Theory", "Too Many Bones")).toBe(true);
    expect(titleMatches("Dice Forge board game", "Dice Forge")).toBe(true);
  });
});

describe("fetchBggMarket", () => {
  it("keeps USD listings and splits new from used", async () => {
    fetchMock.mockResolvedValue(xml(marketXml({
      "1": [listing("new", "40", "2026-01-01"), listing("likenew", "30", "2026-02-01"), listing("acceptable", "15", "2025-02-01"), listing("verygood", "25", "2026-03-01", "EUR"), listing("new", "0", "2026-01-01")],
    })));
    const split = (await run(fetchBggMarket(["1"]))).get("1")!;
    expect(split.new.map((l) => l.price)).toEqual([40]);
    expect(split.used.map((l) => l.price)).toEqual([30, 15]);
    expect(fetchMock.mock.calls[0][0]).toContain("thing?id=1&marketplace=1");
  });
});

describe("quotePrices", () => {
  it("uses recent GeekMarket listings when there are enough", async () => {
    fetchMock.mockResolvedValue(xml(marketXml({
      "1": [listing("good", "20", "2026-01-01"), listing("good", "30", "2026-02-01"), listing("good", "40", "2026-03-01"), listing("good", "99", "2019-01-01"), listing("new", "55", "2026-03-01")],
    })));
    const q = (await run(quotePrices([{ id: "1", name: "Game" }], NOW)))["1"];
    expect(q.used).toMatchObject({ median: 30, count: 3, source: "bgg", since: "2026-01-01" });
    expect(q.new).toMatchObject({ median: 55, count: 1, source: "bgg" });
    expect(q.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it("falls back to eBay when GeekMarket is thin and eBay is configured", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("boardgamegeek")) return xml(marketXml({ "1": [listing("new", "60", "2026-05-01")] }));
      if (url.includes("oauth2/token")) return Response.json({ access_token: "ebay-token", expires_in: 7200 });
      const used = url.includes("1500");
      return Response.json({ itemSummaries: used
        ? [{ title: "Heat Pedal to the Metal board game", price: { value: "35.00", currency: "USD" } }, { title: "Heat Pedal to the Metal", price: { value: "45.00", currency: "USD" } }, { title: "Heat Pedal to the Metal Heavy Rain expansion", price: { value: "20.00", currency: "USD" } }, { title: "Heat: Pedal to the Metal used", price: { value: "40.00", currency: "USD" } }]
        : [{ title: "Heat Pedal to the Metal NEW sealed", price: { value: "50.00", currency: "USD" } }] });
    });
    const q = (await run(quotePrices([{ id: "1", name: "Heat: Pedal to the Metal" }], NOW)))["1"];
    expect(q.used).toMatchObject({ source: "ebay", median: 40, count: 3 });
    // One new listing on each site: neither reaches the minimum, so the tie goes to BGG.
    expect(q.new).toMatchObject({ source: "bgg", median: 60 });
    const search = fetchMock.mock.calls.find(([u]) => u.includes("item_summary/search"))!;
    expect((search[1]!.headers as Record<string, string>).Authorization).toBe("Bearer ebay-token");
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("oauth2/token"))).toHaveLength(1);
  });

  it("skips eBay when it isn't configured", async () => {
    fetchMock.mockResolvedValue(xml(marketXml({ "1": [] })));
    const q = (await run(quotePrices([{ id: "1", name: "Game" }], NOW)))["1"];
    expect(q).toMatchObject({ used: null, new: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps BGG prices if eBay errors", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url) =>
      url.includes("boardgamegeek") ? xml(marketXml({ "1": [listing("good", "12", "2026-01-01")] })) : new Response("", { status: 500 }));
    const q = (await run(quotePrices([{ id: "1", name: "Game" }], NOW)))["1"];
    expect(q.used).toMatchObject({ source: "bgg", median: 12 });
  });
});
