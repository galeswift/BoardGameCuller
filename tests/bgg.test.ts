import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BggError, fetchBggCollection } from '@/lib/bgg';
import { game } from './helpers';

const collectionXml = (items: string) => `<?xml version="1.0" encoding="utf-8"?><items totalitems="1">${items}</items>`;
const collectionItem = (id: string, name: string, subtype: string, rating: string, average: string) =>
    `<item objecttype="thing" objectid="${id}" subtype="${subtype}" collid="9${id}"><name sortindex="1">${name}</name>
   <stats minplayers="1" maxplayers="5" playingtime="45"><rating value="${rating}"><average value="${average}"/></rating></stats></item>`;

const STANDALONE = collectionXml(
    collectionItem('100', 'Spirit Island', 'boardgame', '9', '8.3') +
        collectionItem('200', 'Hanabi', 'boardgame', 'N/A', '7.0') +
        // Owning two copies yields two rows with the same objectid.
        collectionItem('200', 'Hanabi', 'boardgame', 'N/A', '7.0')
);
const EXPANSIONS = collectionXml(collectionItem('300', 'Spirit Island: Branch & Claw', 'boardgameexpansion', 'N/A', '8.6'));
const THINGS = `<?xml version="1.0" encoding="utf-8"?><items>
 <item type="boardgame" id="100">
  <minplayers value="1"/><maxplayers value="4"/><playingtime value="120"/>
  <poll-summary name="suggested_numplayers"><result name="bestwith" value="Best with 2–3 players"/><result name="recommmendedwith" value="Recommended with 1–4 players"/></poll-summary>
  <link type="boardgamecategory" id="1" value="Card Game"/><link type="boardgamecategory" id="2" value="Fantasy"/>
  <link type="boardgamemechanic" id="3" value="Cooperative Game"/>
  <link type="boardgamefamily" id="6" value="Mechanism: Campaign Games"/><link type="boardgamefamily" id="7" value="Crowdfunding: Kickstarter"/>
  <link type="boardgamepublisher" id="4" value="(Unknown)"/><link type="boardgamepublisher" id="5" value="Greater Than Games"/>
  <statistics><ratings><averageweight value="4.06"/></ratings></statistics>
 </item>
 <item type="boardgame" id="200">
  <minplayers value="2"/><maxplayers value="5"/><playingtime value="25"/>
  <poll-summary name="suggested_numplayers"><result name="bestwith" value="Best with 3, 5 players"/></poll-summary>
  <link type="boardgamecategory" id="1" value="Card Game"/>
  <statistics><ratings><averageweight value="0"/></ratings></statistics>
 </item>
 <item type="boardgameexpansion" id="300">
  <minplayers value="1"/><maxplayers value="4"/><playingtime value="120"/>
  <link type="boardgameexpansion" id="999" value="Some Other Base" inbound="true"/>
  <link type="boardgameexpansion" id="100" value="Spirit Island" inbound="true"/>
  <statistics><ratings><averageweight value="4.2"/></ratings></statistics>
 </item>
</items>`;

const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });
let fetchMock: Mock<(url: string, init?: { headers: Record<string, string> }) => Promise<Response>>;

/** Runs the import while fast-forwarding the deliberate gaps between BGG requests. */
async function run(previous = [] as ReturnType<typeof game>[])
{
    const promise = fetchBggCollection('someone', previous);

    promise.catch(() =>
    {});
    await vi.runAllTimersAsync();

    return promise;
}

beforeEach(() =>
{
    vi.useFakeTimers();
    vi.stubEnv('BGG_API_TOKEN', 'token-123');
    fetchMock = vi.fn(async (url: string) =>
    {
        if (url.includes('excludesubtype=boardgameexpansion'))
        {
            return xml(STANDALONE);
        }

        if (url.includes('subtype=boardgameexpansion'))
        {
            return xml(EXPANSIONS);
        }

        if (url.includes('/thing?'))
        {
            return xml(THINGS);
        }

        throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() =>
{
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('fetchBggCollection', () =>
{
    it("maps owned games and expansions into the app's Game shape", async () =>
    {
        const games = await run();

        expect(games.map(entry => entry.id)).toEqual(['100', '200', '300']);
        const [spirit, hanabi, branch] = games;

        expect(spirit).toMatchObject({
            name: 'Spirit Island',
            type: 'standalone',
            rating: 8.3,
            personalRating: 9,
            complexity: 4.06,
            minutes: 120,
            minPlayers: 1,
            maxPlayers: 4,
            bestPlayers: '2,3',
            mode: 'Cooperative',
            theme: 'Fantasy',
            publisher: 'Greater Than Games',
            categories: ['Card Game', 'Fantasy'],
            mechanics: ['Cooperative Game'],
            // Families about how a game was sold, not how it plays, are dropped.
            families: ['Mechanism: Campaign Games'],
        });
        expect(hanabi).toMatchObject({
            publisher: '',
            personalRating: null,
            complexity: null,
            bestPlayers: '3,5',
            mode: 'Competitive',
            theme: '',
        });
        // Prefers the base game the user actually owns.
        expect(branch).toMatchObject({ type: 'expansion', parentId: '100', parentName: 'Spirit Island' });
    });

    it('sends the bearer token and requests owned items with stats', async () =>
    {
        await run();
        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toContain('username=someone&own=1&stats=1');
        expect(init!.headers.Authorization).toBe('Bearer token-123');
        expect(fetchMock.mock.calls.find(([calledUrl]) => calledUrl.includes('/thing?'))![0]).toContain('id=100,200,300&stats=1');
    });

    it('keeps hand-edited classification from the previous import', async () =>
    {
        const previous = [
            game('100', { group: 'Heavy co-op', theme: 'Nature', mode: 'Solo / cooperative', mean: 3, minutes: 90, notes: 'favourite' }),
        ];
        const [spirit] = await run(previous);

        expect(spirit).toMatchObject({
            group: 'Heavy co-op',
            theme: 'Nature',
            mode: 'Solo / cooperative',
            mean: 3,
            minutes: 90,
            notes: 'favourite',
        });
    });

    it('retries while BGG is still queueing the export (202)', async () =>
    {
        let calls = 0;
        const base = fetchMock.getMockImplementation()!;

        fetchMock.mockImplementation(async (url: string) => (url.includes('excludesubtype') && calls++ < 2 ? xml('', 202) : base(url)));
        expect(await run()).toHaveLength(3);
        expect(calls).toBe(3);
    });

    it('batches thing lookups 20 ids at a time', async () =>
    {
        const many = collectionXml(
            Array.from({ length: 45 }, (_, index) => collectionItem(String(index + 1), `G${index}`, 'boardgame', 'N/A', '6')).join('')
        );

        fetchMock.mockImplementation(async (url: string) =>
            xml(url.includes('excludesubtype') ? many : url.includes('subtype=') ? collectionXml('') : '<items></items>')
        );
        expect(await run()).toHaveLength(45);
        expect(fetchMock.mock.calls.filter(([url]) => url.includes('/thing?'))).toHaveLength(3);
    });

    it('reports an unknown username clearly', async () =>
    {
        fetchMock.mockResolvedValue(xml('<errors><error><message>Invalid username specified</message></error></errors>'));
        await expect(run()).rejects.toThrow('doesn’t recognise that username');
    });

    it('reports an empty collection', async () =>
    {
        fetchMock.mockImplementation(async () => xml(collectionXml('')));
        await expect(run()).rejects.toThrow('No owned games found');
    });

    it('reports a rejected token', async () =>
    {
        fetchMock.mockResolvedValue(xml('', 401));
        await expect(run()).rejects.toThrow('rejected the API token');
    });

    it('requires BGG_API_TOKEN', async () =>
    {
        vi.stubEnv('BGG_API_TOKEN', '');
        await expect(run()).rejects.toBeInstanceOf(BggError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
