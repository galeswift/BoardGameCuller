import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    aiCopy,
    aiPrompt,
    formulaProblems,
    openingFor,
    mayMentionBgg,
    plainPunctuation,
    decodeEntities,
    fetchBggDetails,
    fetchReviews,
    looksEnglish,
    postText,
    templateCopy,
    writeListings,
    type ListingFacts,
} from '@/lib/listing';

const facts = (extra: Partial<ListingFacts> = {}): ListingFacts => ({
    id: '1',
    name: 'Heat',
    publisher: 'Days of Wonder',
    minPlayers: 1,
    maxPlayers: 6,
    bestPlayers: '4,5',
    minutes: 60,
    complexity: 2.2,
    similar: ['Flamme Rouge', 'Downforce'],
    condition: 'Used',
    ...extra,
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

async function run<T>(promise: Promise<T>)
{
    promise.catch(() =>
    {});
    await vi.runAllTimersAsync();

    return promise;
}

const openAi = (content: string) => Response.json({ choices: [{ message: { content } }] });

beforeEach(() =>
{
    vi.useFakeTimers();
    vi.stubEnv('BGG_API_TOKEN', 'token');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_MODEL', '');
    fetchMock = vi.fn(async () => new Response(THING));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() =>
    {});
});
afterEach(() =>
{
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('decodeEntities', () =>
{
    it('decodes double-encoded BGG text', () =>
    {
        expect(decodeEntities('A&amp;#10;B &amp;mdash; C &#8217;s &amp;quot;x&amp;quot;')).toBe('A\nB — C ’s "x"');
    });
});

describe('fetchBggDetails', () =>
{
    it('parses year, rank, description, links and useful comments', async () =>
    {
        const details = (await run(fetchBggDetails(['1']))).get('1')!;

        expect(fetchMock.mock.calls[0][0]).toContain('thing?id=1&comments=1&pagesize=100');
        expect(details).toMatchObject({ year: '2022', categories: ['Racing'], mechanics: ['Hand Management'] });
        expect(details.description).toContain('Race your car around the track.\n\nManage your heat — or spin out!');
        expect(details.comments).toEqual([
            { rating: 9, text: 'Tense racing with clever heat management, plays great at five.' },
            { rating: 7, text: 'Love the "legends" bots for solo play, setup is quick too.' },
        ]);
    });
});

describe('templateCopy', () =>
{
    it('combines facts, the publisher blurb, similar games and rating', async () =>
    {
        const details = (await run(fetchBggDetails(['1']))).get('1');
        const copy = templateCopy(facts(), details);

        expect(copy.intro).toMatch(
            /^Heat \(2022\) is a medium-light board game for 1–6 players that plays in about 60 minutes\. Race your car/
        );
        expect(copy.intro).toContain('Second sentence here.');
        expect(copy.appeal).toBe("If you liked Flamme Rouge or Downforce, you'll probably like this one too.");
        expect(JSON.stringify(copy)).not.toMatch(/rating|rank|\/10/i);
    });

    it('trims the publisher blurb to whole sentences', () =>
    {
        const description = Array.from({ length: 12 }, (_, index) => `Sentence number ${index} is here to pad things out.`).join(' ');
        const copy = templateCopy(facts(), { description, categories: [], mechanics: [], comments: [] });

        expect(copy.intro).toContain('Sentence number 0 is here');
        expect(copy.intro).not.toContain('Sentence number 11');
        expect(copy.intro).toMatch(/.$/);
    });

    it('works without BGG details', () =>
    {
        expect(templateCopy(facts({ similar: [], minPlayers: null }))).toMatchObject({
            intro: 'Heat is a medium-light board game that plays in about 60 minutes.',
            appeal: '',
        });
    });
});

describe('aiCopy', () =>
{
    it('asks OpenAI for JSON with the facts and comments, using gpt-5-mini by default', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        const details = (await run(fetchBggDetails(['1']))).get('1');

        fetchMock.mockResolvedValue(openAi('{"description":"You race riders up the mountain.\\n\\nIt plays a lot like Flamme Rouge."}'));
        expect(await aiCopy(facts(), details)).toEqual({
            intro: 'You race riders up the mountain.',
            appeal: 'It plays a lot like Flamme Rouge.',
        });
        const [url, init] = fetchMock.mock.calls.at(-1)!;

        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
        const body = JSON.parse(String(init!.body));

        expect(body).toMatchObject({
            model: 'gpt-5-mini',
            response_format: { type: 'json_object' },
            reasoning_effort: 'low',
            max_completion_tokens: 2500,
        });
        expect(body.messages[1].content).toContain('Similar games: Flamme Rouge, Downforce');
        expect(body.messages[1].content).toContain('- Tense racing');
        expect(body.messages[1].content).not.toContain('alice');
        expect(body.messages[1].content).not.toMatch(/rating|rank|\/10/i);
        expect(body.messages[0].content).toContain("Don't mention ratings");
    });

    it('omits reasoning_effort for non-reasoning models', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        vi.stubEnv('OPENAI_MODEL', 'gpt-4o-mini');
        fetchMock.mockResolvedValue(openAi('{"description":"x"}'));
        await aiCopy(facts());
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).not.toHaveProperty('reasoning_effort');
    });

    it('rejects malformed replies', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        fetchMock.mockResolvedValue(openAi('{"text":"nope"}'));
        await expect(aiCopy(facts())).rejects.toThrow('unexpected format');
    });
});

describe('comment selection', () =>
{
    it('summarises players who liked the game when there are enough of them', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        const details = {
            description: '',
            categories: [],
            mechanics: [],
            comments: [
                { rating: 9, text: 'Loved it, brilliant tension every game.' },
                { rating: 8, text: 'Great with friends and quick to teach.' },
                { rating: 7, text: 'Solid engine building with a nice arc.' },
                { rating: 3, text: 'Too random and far too long for me.' },
            ],
        };

        fetchMock.mockResolvedValue(openAi('{"description":"x"}'));
        await aiCopy(facts(), details);
        const prompt = JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).messages[1].content;

        expect(prompt).toContain('brilliant tension');
        expect(prompt).not.toContain('Too random');
    });
});

describe('writeListings', () =>
{
    it('uses the template when no OpenAI key is set', async () =>
    {
        const out = await run(writeListings([facts()]));

        expect(out.ai).toBe(false);
        expect(out.copies['1']).toMatchObject({ source: 'template', year: '2022' });
        expect(fetchMock.mock.calls.every(([url]) => !url.includes('openai'))).toBe(true);
    });

    it('uses AI copy when available and falls back per game on failure', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        let openAiCalls = 0;

        fetchMock.mockImplementation(async url =>
            url.includes('openai')
                ? openAiCalls++ === 0
                    ? openAi('{"description":"AI intro.\\n\\nAI appeal."}')
                    : new Response('rate limited', { status: 429 })
                : new Response(
                    THING.replace('id="1"', 'id="1"').replace(
                        '</items>',
                        '<item type="boardgame" id="2"><description>Two.</description></item></items>'
                    )
                )
        );
        const out = await run(writeListings([facts(), facts({ id: '2', name: 'Other' })]));

        expect(out.ai).toBe(true);
        expect(
            Object.values(out.copies)
                .map(copy => copy.source)
                .sort()
        ).toEqual(['ai', 'template']);
        expect(out.warning).toContain('OpenAI request failed');
    });

    it('still writes copy when BGG is unreachable', async () =>
    {
        vi.stubEnv('BGG_API_TOKEN', '');
        const out = await run(writeListings([facts()]));

        expect(out.copies['1'].source).toBe('template');
        expect(out.warning).toContain('Couldn’t reach BoardGameGeek');
    });
});

const FORUMS = `<forums type="thing" id="1"><forum id="77" title="Reviews" numthreads="4" numposts="9"/><forum id="78" title="General" numthreads="50" numposts="300"/></forums>`;
const ENGLISH_REVIEW = 'This is a tense racing game and I love how the heat cards make every corner a gamble. '.repeat(6);
const THREADS = `<forum id="77" title="Reviews"><threads>
  <thread id="501" subject="A great family racer" numarticles="3"/>
  <thread id="502" subject="Video review" numarticles="1"/>
  <thread id="503" subject="Rezension (Deutsch)" numarticles="1"/>
  <thread id="504" subject="Solo &amp;amp; two-player thoughts" numarticles="2"/>
</threads></forum>`;
const article = (body: string) =>
    `<thread id="x"><articles><article id="1" username="someone"><subject>s</subject><body>${body}</body></article></articles></thread>`;
const BODIES: Record<string, string> = {
    '501': `&lt;b&gt;Verdict&lt;/b&gt;&lt;br/&gt;${ENGLISH_REVIEW}`,
    '502': 'Watch it here: https://youtube.com/xyz',
    '503': 'Dieses Spiel ist ein spannendes Rennspiel und die Hitzekarten machen jede Kurve zu einem Wagnis. '.repeat(6),
    '504': ENGLISH_REVIEW,
};

function serveForums()
{
    fetchMock.mockImplementation(async url =>
    {
        if (url.includes('forumlist'))
        {
            return new Response(FORUMS);
        }

        if (url.includes('forum?id=77'))
        {
            return new Response(THREADS);
        }

        const thread = url.match(/thread\?id=(\d+)/)?.[1];

        if (thread)
        {
            return new Response(article(BODIES[thread]));
        }

        if (url.includes('openai'))
        {
            return openAi('{"description":"AI intro.\\n\\nAI appeal."}');
        }

        return new Response(THING);
    });
}

describe('postText and looksEnglish', () =>
{
    it('turns an encoded forum post into plain text', () =>
    {
        expect(postText('&lt;b&gt;Verdict&lt;/b&gt;&lt;br/&gt;Fun &amp;amp; fast&lt;br/&gt;&lt;br/&gt;Recommended')).toBe(
            'Verdict\nFun & fast\n\nRecommended'
        );
    });
    it('tells English reviews apart from other languages and link-only posts', () =>
    {
        expect(looksEnglish(ENGLISH_REVIEW)).toBe(true);
        expect(looksEnglish(BODIES['503'])).toBe(false);
        expect(looksEnglish('Great game')).toBe(false);
    });
});

describe('fetchReviews', () =>
{
    it('takes the opening post of recent English threads in the Reviews forum', async () =>
    {
        serveForums();
        const reviews = await run(fetchReviews('1'));

        expect(reviews.map(review => review.subject)).toEqual(['A great family racer', 'Solo & two-player thoughts']);
        expect(reviews[0].text.startsWith('Verdict\nThis is a tense racing game')).toBe(true);
        expect(reviews[0].text.length).toBeLessThanOrEqual(1500);
        const urls = fetchMock.mock.calls.map(([url]) => url);

        expect(urls[0]).toContain('forumlist?id=1&type=thing');
        expect(urls[1]).toContain('forum?id=77');
        expect(urls.filter(url => url.includes('thread?id=')).every(url => url.endsWith('&count=1'))).toBe(true);
    });

    it('stops at three reviews', async () =>
    {
        BODIES['502'] = ENGLISH_REVIEW;
        BODIES['503'] = ENGLISH_REVIEW;
        serveForums();
        expect(await run(fetchReviews('1'))).toHaveLength(3);
        expect(fetchMock.mock.calls.filter(([url]) => url.includes('thread?id=504'))).toHaveLength(0);
        BODIES['502'] = 'Watch it here: https://youtube.com/xyz';
        BODIES['503'] = 'Dieses Spiel ist ein spannendes Rennspiel. '.repeat(10);
    });

    it('returns nothing when the game has no reviews', async () =>
    {
        fetchMock.mockResolvedValue(new Response(`<forums><forum id="9" title="Reviews" numthreads="0"/></forums>`));
        expect(await run(fetchReviews('1'))).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('aiPrompt', () =>
{
    it('includes reviews and the most substantive liked comments', () =>
    {
        const details = {
            description: '',
            categories: [],
            mechanics: [],
            reviews: [{ subject: 'Great racer', text: 'Loved the tension of every corner.' }],
            comments: [
                { rating: 8, text: 'Short but sweet, plays fast.' },
                { rating: 9, text: 'Long comment with a lot of detail about why the heat system makes every lap feel tense and exciting.' },
                { rating: 7, text: 'Solid fun.' },
            ],
        };
        const prompt = aiPrompt(facts(), details);

        expect(prompt).toContain("Player reviews (summarise what reviewers enjoy, don't quote):\n### Great racer\nLoved the tension");
        expect(prompt.indexOf('Long comment')).toBeLessThan(prompt.indexOf('Short but sweet'));
    });
});

describe('writeListings with reviews', () =>
{
    it('fetches reviews for the AI and returns them for caching', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        serveForums();
        const out = await run(writeListings([facts()]));

        expect(out.fetchedReviews['1'].map(review => review.subject)).toEqual(['A great family racer', 'Solo & two-player thoughts']);
        const prompt = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url.includes('openai'))![1]!.body)).messages[1].content;

        expect(prompt).toContain('### A great family racer');
        expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url.includes('openai'))![1]!.body)).messages[0].content).toContain(
            'leave out complaints'
        );
    });

    it('uses cached reviews instead of fetching them again', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        serveForums();
        const out = await run(
            writeListings([facts()], { cachedReviews: new Map([['1', [{ subject: 'Cached review', text: 'From the cache.' }]]]) })
        );

        expect(out.fetchedReviews).toEqual({});
        expect(fetchMock.mock.calls.some(([url]) => url.includes('forum'))).toBe(false);
        expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url.includes('openai'))![1]!.body)).messages[1].content).toContain(
            '### Cached review'
        );
    });

    it("skips reviews when there's no AI to use them", async () =>
    {
        serveForums();
        const out = await run(writeListings([facts()]));

        expect(out.fetchedReviews).toEqual({});
        expect(fetchMock.mock.calls.some(([url]) => url.includes('forum'))).toBe(false);
    });
});

describe('writing voice', () =>
{
    it("asks for the seller's casual voice, using their own writing as the example", async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        fetchMock.mockResolvedValue(openAi('{"description":"x"}'));
        await aiCopy(facts());
        const system: string = JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).messages[0].content;

        expect(system).toContain('casual and conversational');
        expect(system).toContain('Looking at what people say on BoardGameGeek, people like the decision space of how to spend loot');
        expect(system).toMatch(/Avoid: hype or marketing words[^\n]*em dashes/);
        expect(system).toContain('Write one description of 45 to 80 words');
        expect(system).toContain('Never write sentences where a group likes something');
    });
});

describe('plainPunctuation', () =>
{
    it('swaps semicolons, dashes and exclamation marks for plain punctuation', () =>
    {
        expect(plainPunctuation('You draft tiles; it plays in 45 minutes!')).toBe('You draft tiles. It plays in 45 minutes.');
        expect(plainPunctuation('A quick game — great for two')).toBe('A quick game, great for two');
        expect(plainPunctuation('Plays 1–4 players')).toBe('Plays 1–4 players');
    });

    it("is applied to AI copy, which must not claim the seller's own experience", async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        fetchMock.mockResolvedValue(openAi('{"description":"You crawl a dice dungeon; it plays fast.\\n\\nThe loot — and the boss!"}'));
        expect(await aiCopy(facts())).toEqual({ intro: 'You crawl a dice dungeon. It plays fast.', appeal: 'The loot, and the boss.' });
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).messages[0].content).toContain(
            "Never invent the seller's own experience"
        );
    });
});

describe('BoardGameGeek mentions', () =>
{
    it('lets only about one game in four mention BoardGameGeek, the same way every time', () =>
    {
        const ids = Array.from({ length: 400 }, (_, index) => String(100000 + index));

        expect(ids.filter(mayMentionBgg)).toHaveLength(100);
        expect(mayMentionBgg('266192')).toBe(true);
        expect(mayMentionBgg('311715')).toBe(false);
    });

    it('tells the model whether this listing may name BoardGameGeek', () =>
    {
        expect(aiPrompt(facts({ id: '266192' }))).toContain('You may mention BoardGameGeek once');
        const other = aiPrompt(facts({ id: '311715' }));

        expect(other).toContain("Don't mention BoardGameGeek or where the opinions come from.");
        expect(other).not.toContain('You may mention BoardGameGeek');
    });
});

describe('description variety', () =>
{
    it('gives each game a stable opening idea, spread across the openings', () =>
    {
        const ids = Array.from({ length: 400 }, (_, index) => String(100000 + index * 7));
        const counts = new Map<string, number>();

        for (const id of ids)
        {
            counts.set(openingFor(id), (counts.get(openingFor(id)) ?? 0) + 1);
        }

        expect(counts.size).toBe(8);
        expect(Math.min(...counts.values())).toBeGreaterThan(20);
        expect(openingFor('266192')).toBe(openingFor('266192'));
        expect(aiPrompt(facts({ id: '266192' }))).toContain(openingFor('266192'));
    });

    it.each([
        ['Players like the loot.', 'Players like'],
        ['People on BoardGameGeek really enjoy the combos.', 'People on BoardGameGeek really enjoy'],
        ['Calm and puzzly. You draft a tile.', 'adjective fragment'],
        ['You give clues. Quick, cooperative, and annoyingly clever.', 'adjective fragment'],
        ['Great if you like teamwork.', 'sign-off'],
        ['Quick turns and easy rules make it work for anyone.', 'sign-off'],
        ['It makes a perfect filler.', '"perfect"'],
        ['Flamme Rouge is a racing game.', 'starts with'],
    ])('flags formula writing: %s', (text, problem) =>
    {
        expect(formulaProblems(text, 'Flamme Rouge').join(' ')).toContain(problem);
    });

    it('lets plain, varied writing through', () =>
    {
        for (const text of [
            "You can't see your own cards. Everyone else can, so you give tiny clues.",
            'On your turn you play a card into the trick and try to win the one you were given.',
            'Reviews on BoardGameGeek keep coming back to the card combos.',
            'It is a good fit for a two-player night.',
        ])
        {
            expect(formulaProblems(text, 'Flamme Rouge')).toEqual([]);
        }
    });

    it('rewrites a formulaic draft once, telling the model what to fix', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        fetchMock
            .mockResolvedValueOnce(openAi('{"description":"Flamme Rouge is a racing game. Players like the sprints."}'))
            .mockResolvedValueOnce(openAi('{"description":"Every sprint is a gamble on your energy cards."}'));

        expect(await aiCopy(facts())).toEqual({ intro: 'Every sprint is a gamble on your energy cards.', appeal: '' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retry = JSON.parse(String(fetchMock.mock.calls[1][1]!.body)).messages[1].content;

        expect(retry).toContain('Your previous draft was:');
        expect(retry).toContain('"Players like" sentence');
    });

    it('keeps the first draft when the rewrite is worse', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        fetchMock
            .mockResolvedValueOnce(openAi('{"description":"Players like the sprints."}'))
            .mockResolvedValueOnce(openAi('{"description":"Flamme Rouge is a perfect racer. Fans love it. Great for families."}'));

        expect((await aiCopy(facts())).intro).toBe('Players like the sprints.');
    });
});
