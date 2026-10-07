import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { aiCopy, aiPrompt, decodeEntities, fetchBggDetails, fetchReviews, looksEnglish, postText, templateCopy, writeListings, type ListingFacts } from "@/lib/listing";

const facts = (extra: Partial<ListingFacts> = {}): ListingFacts => ({
  id: "1", name: "Heat", publisher: "Days of Wonder", minPlayers: 1, maxPlayers: 6, bestPlayers: "4,5", minutes: 60,
  complexity: 2.2, similar: ["Flamme Rouge", "Downforce"], condition: "Used", ...extra,
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
    expect(fetchMock.mock.calls[0][0]).toContain("thing?id=1&comments=1&pagesize=100");
    expect(d).toMatchObject({ year: "2022", categories: ["Racing"], mechanics: ["Hand Management"] });
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
    expect(c.appeal).toBe("If you enjoy Flamme Rouge or Downforce, this is a natural fit for your shelf.");
    expect(JSON.stringify(c)).not.toMatch(/rating|rank|\/10/i);
  });

  it("trims the publisher blurb to whole sentences", () => {
    const description = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here to pad things out.`).join(" ");
    const c = templateCopy(facts(), { description, categories: [], mechanics: [], comments: [] });
    expect(c.intro).toContain("Sentence number 0 is here");
    expect(c.intro).not.toContain("Sentence number 11");
    expect(c.intro).toMatch(/.$/);
  });

  it("works without BGG details", () => {
    expect(templateCopy(facts({ similar: [], minPlayers: null }))).toMatchObject({ intro: "Heat is a medium-light board game that plays in about 60 minutes.", appeal: "" });
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
    expect(body.messages[1].content).toContain("- Tense racing");
    expect(body.messages[1].content).not.toContain("alice");
    expect(body.messages[1].content).not.toMatch(/rating|rank|\/10/i);
    expect(body.messages[0].content).toContain("Don't mention ratings");
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

describe("comment selection", () => {
  it("summarises players who liked the game when there are enough of them", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const d = { description: "", categories: [], mechanics: [], comments: [
      { rating: 9, text: "Loved it, brilliant tension every game." }, { rating: 8, text: "Great with friends and quick to teach." },
      { rating: 7, text: "Solid engine building with a nice arc." }, { rating: 3, text: "Too random and far too long for me." },
    ] };
    fetchMock.mockResolvedValue(openAi('{"intro":"x","appeal":"y"}'));
    await aiCopy(facts(), d);
    const prompt = JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).messages[1].content;
    expect(prompt).toContain("brilliant tension");
    expect(prompt).not.toContain("Too random");
  });
});

describe("writeListings", () => {
  it("uses the template when no OpenAI key is set", async () => {
    const out = await run(writeListings([facts()]));
    expect(out.ai).toBe(false);
    expect(out.copies["1"]).toMatchObject({ source: "template", year: "2022" });
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

const FORUMS = `<forums type="thing" id="1"><forum id="77" title="Reviews" numthreads="4" numposts="9"/><forum id="78" title="General" numthreads="50" numposts="300"/></forums>`;
const ENGLISH_REVIEW = "This is a tense racing game and I love how the heat cards make every corner a gamble. ".repeat(6);
const THREADS = `<forum id="77" title="Reviews"><threads>
  <thread id="501" subject="A great family racer" numarticles="3"/>
  <thread id="502" subject="Video review" numarticles="1"/>
  <thread id="503" subject="Rezension (Deutsch)" numarticles="1"/>
  <thread id="504" subject="Solo &amp;amp; two-player thoughts" numarticles="2"/>
</threads></forum>`;
const article = (body: string) => `<thread id="x"><articles><article id="1" username="someone"><subject>s</subject><body>${body}</body></article></articles></thread>`;
const BODIES: Record<string, string> = {
  "501": `&lt;b&gt;Verdict&lt;/b&gt;&lt;br/&gt;${ENGLISH_REVIEW}`,
  "502": "Watch it here: https://youtube.com/xyz",
  "503": "Dieses Spiel ist ein spannendes Rennspiel und die Hitzekarten machen jede Kurve zu einem Wagnis. ".repeat(6),
  "504": ENGLISH_REVIEW,
};
function serveForums() {
  fetchMock.mockImplementation(async (url) => {
    if (url.includes("forumlist")) return new Response(FORUMS);
    if (url.includes("forum?id=77")) return new Response(THREADS);
    const thread = url.match(/thread\?id=(\d+)/)?.[1];
    if (thread) return new Response(article(BODIES[thread]));
    if (url.includes("openai")) return openAi('{"intro":"AI intro.","appeal":"AI appeal."}');
    return new Response(THING);
  });
}

describe("postText and looksEnglish", () => {
  it("turns an encoded forum post into plain text", () => {
    expect(postText("&lt;b&gt;Verdict&lt;/b&gt;&lt;br/&gt;Fun &amp;amp; fast&lt;br/&gt;&lt;br/&gt;Recommended")).toBe("Verdict\nFun & fast\n\nRecommended");
  });
  it("tells English reviews apart from other languages and link-only posts", () => {
    expect(looksEnglish(ENGLISH_REVIEW)).toBe(true);
    expect(looksEnglish(BODIES["503"])).toBe(false);
    expect(looksEnglish("Great game")).toBe(false);
  });
});

describe("fetchReviews", () => {
  it("takes the opening post of recent English threads in the Reviews forum", async () => {
    serveForums();
    const reviews = await run(fetchReviews("1"));
    expect(reviews.map((r) => r.subject)).toEqual(["A great family racer", "Solo & two-player thoughts"]);
    expect(reviews[0].text.startsWith("Verdict\nThis is a tense racing game")).toBe(true);
    expect(reviews[0].text.length).toBeLessThanOrEqual(1500);
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls[0]).toContain("forumlist?id=1&type=thing");
    expect(urls[1]).toContain("forum?id=77");
    expect(urls.filter((u) => u.includes("thread?id=")).every((u) => u.endsWith("&count=1"))).toBe(true);
  });

  it("stops at three reviews", async () => {
    BODIES["502"] = ENGLISH_REVIEW;
    BODIES["503"] = ENGLISH_REVIEW;
    serveForums();
    expect(await run(fetchReviews("1"))).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("thread?id=504"))).toHaveLength(0);
    BODIES["502"] = "Watch it here: https://youtube.com/xyz";
    BODIES["503"] = "Dieses Spiel ist ein spannendes Rennspiel. ".repeat(10);
  });

  it("returns nothing when the game has no reviews", async () => {
    fetchMock.mockResolvedValue(new Response(`<forums><forum id="9" title="Reviews" numthreads="0"/></forums>`));
    expect(await run(fetchReviews("1"))).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("aiPrompt", () => {
  it("includes reviews and the most substantive liked comments", () => {
    const d = { description: "", categories: [], mechanics: [], reviews: [{ subject: "Great racer", text: "Loved the tension of every corner." }],
      comments: [{ rating: 8, text: "Short but sweet, plays fast." }, { rating: 9, text: "Long comment with a lot of detail about why the heat system makes every lap feel tense and exciting." }, { rating: 7, text: "Solid fun." }] };
    const prompt = aiPrompt(facts(), d);
    expect(prompt).toContain("Player reviews (summarise what reviewers enjoy, don't quote):\n### Great racer\nLoved the tension");
    expect(prompt.indexOf("Long comment")).toBeLessThan(prompt.indexOf("Short but sweet"));
  });
});

describe("writeListings with reviews", () => {
  it("fetches reviews for the AI and returns them for caching", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    serveForums();
    const out = await run(writeListings([facts()]));
    expect(out.fetchedReviews["1"].map((r) => r.subject)).toEqual(["A great family racer", "Solo & two-player thoughts"]);
    const prompt = JSON.parse(String(fetchMock.mock.calls.find(([u]) => u.includes("openai"))![1]!.body)).messages[1].content;
    expect(prompt).toContain("### A great family racer");
    expect(JSON.parse(String(fetchMock.mock.calls.find(([u]) => u.includes("openai"))![1]!.body)).messages[0].content).toContain("leave out their complaints");
  });

  it("uses cached reviews instead of fetching them again", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    serveForums();
    const out = await run(writeListings([facts()], { cachedReviews: new Map([["1", [{ subject: "Cached review", text: "From the cache." }]]]) }));
    expect(out.fetchedReviews).toEqual({});
    expect(fetchMock.mock.calls.some(([u]) => u.includes("forum"))).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([u]) => u.includes("openai"))![1]!.body)).messages[1].content).toContain("### Cached review");
  });

  it("skips reviews when there's no AI to use them", async () => {
    serveForums();
    const out = await run(writeListings([facts()]));
    expect(out.fetchedReviews).toEqual({});
    expect(fetchMock.mock.calls.some(([u]) => u.includes("forum"))).toBe(false);
  });
});
