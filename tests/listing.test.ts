import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { aiCopy, decodeEntities, fetchBggDetails, templateCopy, writeListings, type ListingFacts } from "@/lib/listing";

const facts = (extra: Partial<ListingFacts> = {}): ListingFacts => ({
  id: "1", name: "Heat", publisher: "Days of Wonder", minPlayers: 1, maxPlayers: 6, bestPlayers: "4,5", minutes: 60,
  complexity: 2.2, rating: 8.0, similar: ["Flamme Rouge", "Downforce"], condition: "Used", ...extra,
});
const THING = `<?xml version="1.0" encoding="utf-8"?><items><item type="boardgame" id="1">
 <yearpublished value="2022"/>
 <description>Race your car around the track.&amp;#10;&amp;#10;Manage your heat &amp;mdash; or spin out! Second sentence here. Third sentence that is long enough to be trimmed away eventually because it keeps going and going.</description>
 <link type="boardgamecategory" id="1" value="Racing"/><link type="boardgamemechanic" id="2" value="Hand Management"/>
 <statistics><ratings><ranks><rank type="subtype" name="boardgame" value="42"/><rank type="family" name="familygames" value="3"/></ranks></ratings></statistics>
 <comments page="1" totalitems="3">
  <comment username="alice" rating="9" value="Tense racing with clever heat management, plays great at five."/>
  <comment username="bob" rating="N/A" value="meh"/>
  <comment username="carol" rating="7" value="Love the &amp;quot;legends&amp;quot; bots for solo play, setup is quick too."/>
 </comments>
</item></items>`;

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
async function run<T>(p: Promise<T>) { p.catch(() => {}); await vi.runAllTimersAsync(); return p; }
const openAi = (content: string) => Response.json({ choices: [{ message: { content } }] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BGG_API_TOKEN", "token");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "");
  fetchMock = vi.fn(async () => new Response(THING));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("decodeEntities", () => {
  it("decodes double-encoded BGG text", () => {
    expect(decodeEntities("A&amp;#10;B &amp;mdash; C &#8217;s &amp;quot;x&amp;quot;")).toBe("A\nB — C ’s \"x\"");
  });
});

describe("fetchBggDetails", () => {
  it("parses year, rank, description, links and useful comments", async () => {
    const d = (await run(fetchBggDetails(["1"]))).get("1")!;
    expect(fetchMock.mock.calls[0][0]).toContain("thing?id=1&stats=1&comments=1&pagesize=25");
    expect(d).toMatchObject({ year: "2022", rank: 42, categories: ["Racing"], mechanics: ["Hand Management"] });
    expect(d.description).toContain("Race your car around the track.\n\nManage your heat — or spin out!");
    expect(d.comments).toEqual([
      { rating: 9, text: "Tense racing with clever heat management, plays great at five." },
      { rating: 7, text: "Love the \"legends\" bots for solo play, setup is quick too." },
    ]);
  });
});

describe("templateCopy", () => {
  it("combines facts, the publisher blurb, similar games and rating", async () => {
    const d = (await run(fetchBggDetails(["1"]))).get("1");
    const c = templateCopy(facts(), d);
    expect(c.intro).toMatch(/^Heat \(2022\) is a medium-light board game for 1–6 players that plays in about 60 minutes\. Race your car/);
    expect(c.intro).toContain("Second sentence here.");
    expect(c.appeal).toBe("If you enjoy Flamme Rouge or Downforce, this is a natural fit for your shelf. It holds a 8.0/10 average rating on BoardGameGeek and ranks #42 overall.");
  });

  it("trims the publisher blurb to whole sentences", () => {
    const description = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here to pad things out.`).join(" ");
    const c = templateCopy(facts(), { description, categories: [], mechanics: [], comments: [] });
    expect(c.intro).toContain("Sentence number 0 is here");
    expect(c.intro).not.toContain("Sentence number 11");
    expect(c.intro).toMatch(/.$/);
  });

  it("works without BGG details", () => {
    expect(templateCopy(facts({ similar: [], minPlayers: null }))).toMatchObject({ intro: "Heat is a medium-light board game that plays in about 60 minutes.", appeal: "It holds a 8.0/10 average rating on BoardGameGeek." });
  });
});

describe("aiCopy", () => {
  it("asks OpenAI for JSON with the facts and comments, using gpt-5-mini by default", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const d = (await run(fetchBggDetails(["1"]))).get("1");
    fetchMock.mockResolvedValue(openAi('{"intro":"A racing game.","appeal":"Fans of Flamme Rouge will love it."}'));
    expect(await aiCopy(facts(), d)).toEqual({ intro: "A racing game.", appeal: "Fans of Flamme Rouge will love it." });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: "gpt-5-mini", response_format: { type: "json_object" }, reasoning_effort: "low", max_completion_tokens: 2500 });
    expect(body.messages[1].content).toContain("Similar games: Flamme Rouge, Downforce");
    expect(body.messages[1].content).toContain("[9/10] Tense racing");
    expect(body.messages[1].content).not.toContain("alice");
  });

  it("omits reasoning_effort for non-reasoning models", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
    fetchMock.mockResolvedValue(openAi('{"intro":"x","appeal":"y"}'));
    await aiCopy(facts());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).not.toHaveProperty("reasoning_effort");
  });

  it("rejects malformed replies", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    fetchMock.mockResolvedValue(openAi('{"text":"nope"}'));
    await expect(aiCopy(facts())).rejects.toThrow("unexpected format");
  });
});

describe("writeListings", () => {
  it("uses the template when no OpenAI key is set", async () => {
    const out = await run(writeListings([facts()]));
    expect(out.ai).toBe(false);
    expect(out.copies["1"]).toMatchObject({ source: "template", year: "2022", rank: 42 });
    expect(fetchMock.mock.calls.every(([u]) => !u.includes("openai"))).toBe(true);
  });

  it("uses AI copy when available and falls back per game on failure", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    let n = 0;
    fetchMock.mockImplementation(async (url) => url.includes("openai")
      ? (n++ === 0 ? openAi('{"intro":"AI intro.","appeal":"AI appeal."}') : new Response("rate limited", { status: 429 }))
      : new Response(THING.replace('id="1"', 'id="1"').replace("</items>", '<item type="boardgame" id="2"><description>Two.</description></item></items>')));
    const out = await run(writeListings([facts(), facts({ id: "2", name: "Other" })]));
    expect(out.ai).toBe(true);
    expect(Object.values(out.copies).map((c) => c.source).sort()).toEqual(["ai", "template"]);
    expect(out.warning).toContain("OpenAI request failed");
  });

  it("still writes copy when BGG is unreachable", async () => {
    vi.stubEnv("BGG_API_TOKEN", "");
    const out = await run(writeListings([facts()]));
    expect(out.copies["1"].source).toBe("template");
    expect(out.warning).toContain("Couldn’t reach BoardGameGeek");
  });
});
