import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { accessoryOnly, availableSources, combine, estimate, fetchBgp, fetchBggMarket, missesSources, quotePrices, resetEbayToken, titleMatches, type PriceQuote, type SourceEstimate } from "@/lib/prices";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const SITE = { sitename: "https://cull.test", now: NOW };
const day = (iso: string) => new Date(iso).toUTCString();
const listing = (condition: string, price: string, date: string, currency = "USD") =>
  `<listing><listdate value="${day(date)}"/><price currency="${currency}" value="${price}"/><condition value="${condition}"/><notes value=""/></listing>`;
const marketXml = (items: Record<string, string[]>) =>
  `<?xml version="1.0" encoding="utf-8"?><items>${Object.entries(items)
    .map(([id, ls]) => `<item type="boardgame" id="${id}"><marketplacelistings>${ls.join("")}</marketplacelistings></item>`)
    .join("")}</items>`;
type StorePrice = { product: number; shipping: number | string; shipping_known: boolean; stock: string };
const bgpJson = (items: Record<string, StorePrice[]>) => Response.json({
  currency: "USD",
  items: Object.entries(items).map(([eid, prices]) => ({ external_id: eid, url: `https://boardgameprices.com/item/show/${eid}`, prices })),
});
const store = (product: number, shipping: number | string = 0, shipping_known = true, stock = "Y"): StorePrice => ({ product, shipping, shipping_known, stock });

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
async function run<T>(promise: Promise<T>) {
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}
/** Routes fake responses by host. */
function serve({ bgg = marketXml({}), bgp = bgpJson({}), ebay }: { bgg?: string; bgp?: Response; ebay?: (url: string) => Response }) {
  fetchMock.mockImplementation(async (url) => {
    if (url.includes("boardgamegeek")) return new Response(bgg);
    if (url.includes("boardgameprices")) return bgp.clone();
    if (url.includes("oauth2/token")) return Response.json({ access_token: "ebay-token", expires_in: 7200 });
    if (url.includes("ebay") && ebay) return ebay(url);
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BGG_API_TOKEN", "token");
  vi.stubEnv("EBAY_CLIENT_ID", "");
  vi.stubEnv("EBAY_CLIENT_SECRET", "");
  resetEbayToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("estimate", () => {
  it("takes the median, range, dates and median shipping", () => {
    expect(estimate([{ price: 30, shipping: 8 }, { price: 10 }, { price: 200, shipping: 12 }], "ebay")).toEqual({ source: "ebay", median: 30, low: 10, high: 200, count: 3, shipping: 10 });
    expect(estimate([{ price: 5, date: Date.parse("2025-03-02") }, { price: 6, date: Date.parse("2024-01-09") }], "bgg")).toMatchObject({ median: 5.5, since: "2024-01-09", until: "2025-03-02" });
    expect(estimate([], "bgg")).toBeNull();
  });
});

describe("combine", () => {
  const e = (source: SourceEstimate["source"], median: number, count: number, shipping?: number): SourceEstimate =>
    ({ source, median, low: median - 5, high: median + 5, count, ...(shipping != null ? { shipping } : {}) });

  it("averages every source with enough listings", () => {
    expect(combine(e("bgg", 20, 4), e("ebay", 30, 10, 8), e("bgp", 40, 25, 6))).toMatchObject({ median: 30, low: 15, high: 45, count: 39, shipping: 7 });
  });
  it("leaves out thin sources when a well-supported one exists", () => {
    const c = combine(e("bgg", 99, 1), e("ebay", 30, 5));
    expect(c).toMatchObject({ median: 30, count: 5 });
    expect(c!.sources.map((s) => s.source)).toEqual(["ebay"]);
  });
  it("averages thin sources when nothing is well supported", () => {
    expect(combine(e("bgg", 20, 1), null, e("bgp", 40, 2))).toMatchObject({ median: 30, count: 3 });
    expect(combine(null, null)).toBeNull();
  });
  it("omits shipping when no source knows it", () => {
    expect(combine(e("bgg", 20, 3))).not.toHaveProperty("shipping");
  });
});

describe("titleMatches", () => {
  it("needs every meaningful word of the game name", () => {
    expect(titleMatches("Wingspan Board Game - Stonemaier, complete", "Wingspan")).toBe(true);
    expect(titleMatches("The Castles of Burgundy board game", "Castles of Burgundy")).toBe(true);
    expect(titleMatches("Wings of Glory WW1", "Wingspan")).toBe(false);
  });
  it("rejects accessories, partial lots and expansions", () => {
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
    serve({ bgg: marketXml({ "1": [listing("new", "40", "2026-01-01"), listing("likenew", "30", "2026-02-01"), listing("acceptable", "15", "2025-02-01"), listing("verygood", "25", "2026-03-01", "EUR"), listing("new", "0", "2026-01-01")] }) });
    const split = (await run(fetchBggMarket(["1"]))).get("1")!;
    expect(split.new.map((l) => l.price)).toEqual([40]);
    expect(split.used.map((l) => l.price)).toEqual([30, 15]);
    expect(fetchMock.mock.calls[0][0]).toContain("thing?id=1&marketplace=1");
  });
});

describe("fetchBgp", () => {
  it("keeps in-stock store prices with known shipping, by BGG ID", async () => {
    serve({ bgp: bgpJson({ "13": [store(29.99, "5.00"), store(39.99, "6.99"), store(45, 0, false), store(19.99, "4.00", true, "N"), store(25, 0, true, "?")] }) });
    const result = (await run(fetchBgp(["13"], "https://cull.test"))).get("13")!;
    expect(result.listings).toEqual([{ price: 29.99, shipping: 5 }, { price: 39.99, shipping: 6.99 }, { price: 45 }]);
    expect(result.url).toBe("https://boardgameprices.com/item/show/13");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ eid: "13", sitename: "https://cull.test", currency: "USD", destination: "US" });
  });
});

describe("quotePrices", () => {
  it("averages GeekMarket, eBay and BoardGamePrices.com for new, and keeps shipping separate", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
    serve({
      bgg: marketXml({ "1": [listing("good", "20", "2026-01-01"), listing("good", "30", "2026-02-01"), listing("good", "40", "2026-03-01"), listing("new", "50", "2026-03-01"), listing("new", "52", "2026-04-01"), listing("new", "54", "2026-05-01")] }),
      bgp: bgpJson({ "1": [store(40, "6.00"), store(42, "6.00"), store(44, "8.00")] }),
      ebay: (url) => Response.json({ itemSummaries: (url.includes("1500") ? [34, 36, 38] : [60, 62, 64]).map((p) => ({ title: "Heat Pedal to the Metal board game", price: { value: String(p), currency: "USD" }, shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "9.00", currency: "USD" } }] })) }),
    });
    const out = await run(quotePrices([{ id: "1", name: "Heat: Pedal to the Metal" }], SITE));
    expect(out.sources.sort()).toEqual(["bgg", "bgp", "ebay"]);
    const q = out.quotes["1"];
    expect(q).toMatchObject({ v: 3, checkedAt: new Date(NOW).toISOString(), sources: ["bgg", "bgp", "ebay"] });
    // Used: BGG 30 and eBay 36 → 33; only eBay knows shipping (9).
    expect(q.used).toMatchObject({ median: 33, shipping: 9, count: 6 });
    expect(q.used!.sources.map((s) => s.source)).toEqual(["bgg", "ebay"]);
    // New: BGG 52, eBay 62, stores 42 → 52; shipping is the mean of eBay 9 and stores 6.
    expect(q.new).toMatchObject({ median: 52, shipping: 7.5, count: 9 });
    expect(q.new!.sources.find((s) => s.source === "bgp")).toMatchObject({ median: 42, url: "https://boardgameprices.com/item/show/1" });
  });

  it("uses whatever is available when eBay isn't configured", async () => {
    serve({ bgg: marketXml({ "1": [listing("good", "14", "2026-01-01")] }), bgp: bgpJson({ "1": [store(40, "5.00"), store(44, "5.00"), store(48, "5.00")] }) });
    const out = await run(quotePrices([{ id: "1", name: "Game" }], SITE));
    expect(out.sources.sort()).toEqual(["bgg", "bgp"]);
    expect(out.quotes["1"].used).toMatchObject({ median: 14, count: 1 });
    expect(out.quotes["1"].new).toMatchObject({ median: 44, shipping: 5 });
    expect(fetchMock.mock.calls.some(([u]) => u.includes("ebay"))).toBe(false);
  });

  it("prefers recent GeekMarket listings, falling back to older ones", async () => {
    serve({ bgg: marketXml({
      "1": [listing("good", "20", "2026-01-01"), listing("good", "30", "2026-02-01"), listing("good", "40", "2026-03-01"), listing("good", "99", "2019-01-01")],
      "2": [listing("good", "15", "2018-01-01"), listing("good", "25", "2019-01-01")],
    }) });
    const out = await run(quotePrices([{ id: "1", name: "A" }, { id: "2", name: "B" }], SITE));
    expect(out.quotes["1"].used).toMatchObject({ median: 30, count: 3 });
    expect(out.quotes["2"].used).toMatchObject({ median: 20, count: 2 });
  });

  it("carries on when a source fails, and reports it", async () => {
    serve({ bgg: marketXml({ "1": [listing("good", "12", "2026-01-01")] }), bgp: new Response("down", { status: 503 }) });
    const out = await run(quotePrices([{ id: "1", name: "Game" }], SITE));
    expect(out.sources).toEqual(["bgg"]);
    expect(out.warnings).toEqual(["BoardGamePrices.com unavailable."]);
    expect(out.quotes["1"].used).toMatchObject({ median: 12 });
  });

  it("reports BGG being unavailable without failing the other sources", async () => {
    vi.stubEnv("BGG_API_TOKEN", "");
    serve({ bgp: bgpJson({ "1": [store(40, "5.00")] }) });
    const out = await run(quotePrices([{ id: "1", name: "Game" }], SITE));
    expect(out.sources).toEqual(["bgp"]);
    expect(out.warnings[0]).toContain("BGG GeekMarket unavailable");
    expect(out.quotes["1"]).toMatchObject({ used: null, new: { median: 40 } });
  });
});

describe("missesSources", () => {
  const quote = (sources?: PriceQuote["sources"]): PriceQuote => ({ v: 3, used: null, new: null, checkedAt: "2026-10-01T00:00:00Z", ...(sources ? { sources } : {}) });
  it("flags quotes made without a source that's available now", () => {
    expect(availableSources()).toEqual(["bgg", "bgp"]);
    expect(missesSources(quote(["bgp"]))).toBe(true);
    expect(missesSources(quote(["bgg", "bgp"]))).toBe(false);
    expect(missesSources(quote())).toBe(true);
  });
  it("follows configuration, e.g. once eBay keys are added", () => {
    vi.stubEnv("EBAY_CLIENT_ID", "id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
    expect(missesSources(quote(["bgg", "bgp"]))).toBe(true);
    vi.stubEnv("BGG_API_TOKEN", "");
    expect(availableSources()).toEqual(["ebay", "bgp"]);
  });
  it("records which sources answered", async () => {
    serve({ bgp: new Response("down", { status: 503 }) });
    const out = await run(quotePrices([{ id: "1", name: "Game" }], SITE));
    expect(out.quotes["1"].sources).toEqual(["bgg"]);
    expect(missesSources(out.quotes["1"])).toBe(true);
  });
});

describe("accessoryOnly", () => {
  it("spots listings for accessories or parts", () => {
    expect(accessoryOnly("See images. This is for the dual layer player mats only. They keep the cubes from sliding.")).toBe(true);
    expect(accessoryOnly("Sleeves only, no game")).toBe(true);
    expect(accessoryOnly("Box only - no components")).toBe(true);
    expect(accessoryOnly("Selling for parts")).toBe(true);
    expect(accessoryOnly("Promo cards only")).toBe(true);
  });
  it("keeps real copies of the game", () => {
    expect(accessoryOnly("KS edition - Base game only with Foil Card replacements. No expansions.")).toBe(false);
    expect(accessoryOnly("Cards sleeved. Only played once.")).toBe(false);
    expect(accessoryOnly("Complete, includes insert and promos")).toBe(false);
    expect(accessoryOnly("")).toBe(false);
  });
});

describe("bad data", () => {
  it("skips GeekMarket listings whose notes say they're accessories only", async () => {
    const mats = `<listing><listdate value="${day("2026-09-15")}"/><price currency="USD" value="10.00"/><condition value="new"/><notes value="This is for the dual layer player mats only."/></listing>`;
    serve({ bgg: marketXml({ "1": [mats, listing("new", "24", "2026-05-01")] }) });
    expect((await run(fetchBggMarket(["1"]))).get("1")!.new.map((l) => l.price)).toEqual([24]);
  });

  it("merges every BoardGamePrices.com item for a BGG ID and keeps US stores only", async () => {
    serve({ bgp: Response.json({ currency: "USD", items: [
      { external_id: "1", url: "https://bgp/item/a", prices: [{ ...store(14.99, "6.99"), country: "US" }, { ...store(24.54, "10.52"), country: "CA" }] },
      { external_id: "1", url: "https://bgp/item/b", prices: [{ ...store(20.97, "5.00"), country: "US" }, { ...store(38.03), country: "DE" }] },
      { external_id: "1", url: "https://bgp/item/c", prices: [] },
    ] }) });
    const r = (await run(fetchBgp(["1"], "https://cull.test"))).get("1")!;
    expect(r.listings.map((l) => l.price)).toEqual([14.99, 20.97]);
    expect(r.url).toBe("https://bgp/item/a");
  });

  it("drops listings far below the store price once there are enough store prices", async () => {
    serve({
      bgg: marketXml({ "1": ["9", "38", "39", "41"].map((v) => listing("new", v, "2026-05-01")).concat(["8", "20", "22", "24"].map((v) => listing("good", v, "2026-05-01"))) }),
      bgp: bgpJson({ "1": [store(36, "5.00"), store(40, "5.00"), store(44, "5.00")] }),
    });
    const q = (await run(quotePrices([{ id: "1", name: "Game" }], SITE))).quotes["1"];
    // New floor is half of $40 retail ($20): the $9 listing goes. Used floor is 30% ($12): the $8 one goes.
    expect(q.new!.sources.find((s) => s.source === "bgg")).toMatchObject({ count: 3, median: 39 });
    expect(q.new).toMatchObject({ median: 39.5 });
    expect(q.used).toMatchObject({ median: 22, count: 3 });
  });

  it("keeps cheap listings when there's no store price to compare against", async () => {
    serve({ bgg: marketXml({ "1": [listing("good", "8", "2026-05-01")] }) });
    expect((await run(quotePrices([{ id: "1", name: "Game" }], SITE))).quotes["1"].used).toMatchObject({ median: 8 });
  });
});
