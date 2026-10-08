import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '@/lib/model';
import type { PriceQuote, QuoteResult } from '@/lib/prices';
import type { ListingFacts, ListingResult, Review } from '@/lib/listing';
import type { GroupInput } from '@/lib/groups';
import type { SyncProgress } from '@/lib/bgg';

const mocks = vi.hoisted(() => ({
    signedIn: true,
    token: '',
    pool: null as unknown,
    fetchBgg: null as unknown as (username: string, previous: Game[], onProgress?: SyncProgress) => Promise<Game[]>,
    quote: null as unknown as (games: { id: string; name: string }[], opts: { sitename: string }) => Promise<QuoteResult>,
    write: null as unknown as (games: ListingFacts[], opts: { cachedReviews?: Map<string, Review[]> }) => Promise<ListingResult>,
    group: null as unknown as (batch: GroupInput[], existing: string[]) => Promise<Record<string, string>>,
}));

vi.mock('@/lib/groups', async original => ({
    ...(await original<object>()),
    assignGroups: (batch: GroupInput[], existing: string[]) => mocks.group(batch, existing),
}));
vi.mock('@/lib/listing', async original => ({
    ...(await original<object>()),
    writeListings: (games: ListingFacts[], opts: { cachedReviews?: Map<string, Review[]> }) => mocks.write(games, opts),
}));
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: () => (mocks.signedIn ? { value: mocks.token } : undefined) }),
}));
vi.mock('@/db', async original => ({ ...(await original<object>()), getDb: async () => mocks.pool }));
vi.mock('@/lib/prices', async original => ({
    ...(await original<object>()),
    quotePrices: (games: { id: string; name: string }[], opts: { sitename: string }) => mocks.quote(games, opts),
}));
vi.mock('@/lib/bgg', async original => ({
    ...(await original<object>()),
    fetchBggCollection: (username: string, previous: Game[], onProgress?: SyncProgress) => mocks.fetchBgg(username, previous, onProgress),
    fetchThingDetails: async () => new Map(),
}));

import { demoToken, sessionToken } from '@/app/auth';
import { GET, POST } from '@/app/api/state/route';
import { POST as prices } from '@/app/api/prices/route';
import { GET as importStatus, POST as importBgg } from '@/app/api/bgg/route';
import { syncSettled } from '@/lib/sync-jobs';
import { defaultProfile } from '@/lib/profile';
import { POST as describe_ } from '@/app/api/ebay/descriptions/route';
import { POST as groupsRoute } from '@/app/api/groups/route';
import { BggError } from '@/lib/bgg';
import { defaults } from '@/lib/model';
import seed from '@/lib/collection.json';
import { apiRequest, createTestDb, game } from './helpers';

const quoteFor = (id: string, checkedAt = new Date().toISOString()): PriceQuote => ({
    v: 3,
    checkedAt,
    new: null,
    sources: ['bgg', 'bgp'],
    used: {
        median: Number(id) * 10,
        low: 1,
        high: 99,
        count: 3,
        sources: [{ source: 'bgg', median: Number(id) * 10, low: 1, high: 99, count: 3 }],
    },
});
const quotes = (games: { id: string }[]): QuoteResult => ({
    quotes: Object.fromEntries(games.map(entry => [entry.id, quoteFor(entry.id)])),
    sources: ['bgg'],
    warnings: [],
});
const lookup = async (mode: string, ids: string[]) =>
{
    const res = await prices(
        apiRequest('/api/prices', { method: 'POST', body: { mode, games: ids.map(id => ({ id, name: `Game ${id}` })) } })
    );

    return { status: res.status, body: await res.json() };
};

const load = async (profile?: string) =>
{
    const res = await GET(apiRequest(`/api/state${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`));

    return { status: res.status, body: await res.json() };
};

const save = async (body: unknown, origin?: string) =>
{
    const res = await POST(apiRequest('/api/state', { method: 'POST', body, origin }));

    return { status: res.status, body: await res.json() };
};

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () =>
{
    db = await createTestDb();
    mocks.pool = db.pool;
});

beforeEach(async () =>
{
    await db.pg.exec('TRUNCATE collection_state, preferences, prices, bgg_reviews, sync_jobs');
    mocks.signedIn = true;
    mocks.token = sessionToken()!;
    mocks.fetchBgg = async () => [game('1'), game('2')];
    mocks.quote = async games => quotes(games);
});

describe('auth and request checks', () =>
{
    it('requires sign-in', async () =>
    {
        mocks.signedIn = false;
        expect((await load()).status).toBe(401);
        expect((await save({ action: 'settings', patch: { target: 5 } })).status).toBe(401);
        expect((await importBgg(apiRequest('/api/bgg', { method: 'POST', body: {} }))).status).toBe(401);
    });

    it('rejects cross-site writes', async () =>
    {
        expect((await save({ action: 'settings', patch: { target: 5 } }, 'https://evil.example')).status).toBe(403);
        expect((await importBgg(apiRequest('/api/bgg', { method: 'POST', body: {}, origin: 'https://evil.example' }))).status).toBe(403);
    });

    it('rejects invalid profile names', async () =>
    {
        expect((await load('../etc')).status).toBe(400);
        expect((await save({ profile: '<x>', action: 'settings', patch: { target: 5 } })).status).toBe(400);
    });

    it('rejects unknown actions and invalid payloads', async () =>
    {
        expect((await save({ action: 'drop' })).body.error).toBe('Unknown action.');
        expect((await save({ action: 'preference', id: 'abc', patch: { thumb: 1 } })).status).toBe(400);
    });
});

describe('profiles', () =>
{
    it('serves the bundled collection to the default profile', async () =>
    {
        const { body } = await load();

        expect(body.profile).toBe('galeswift');
        expect(body.games).toHaveLength(seed.length);
        expect(body.settings).toEqual(defaults);
        expect(body.savedAt).toBeNull();
    });

    it('starts other profiles empty and keeps their data separate', async () =>
    {
        expect((await load('Friend')).body).toMatchObject({ profile: 'friend', games: [], preferences: {} });

        await save({ profile: 'friend', action: 'collection', games: [game('10')] });
        await save({ profile: 'friend', action: 'preference', id: '10', patch: { thumb: -1 } });
        await save({ action: 'preference', id: '10', patch: { thumb: 1 } });

        const friend = (await load('friend')).body;
        const myState = (await load()).body;

        expect(friend.games.map((entry: Game) => entry.id)).toEqual(['10']);
        expect(friend.preferences).toEqual({ '10': { thumb: -1 } });
        expect(myState.preferences).toEqual({ '10': { thumb: 1 } });
        expect(myState.games).toHaveLength(seed.length);
        expect(myState.profiles).toEqual(['friend', 'galeswift']);
    });
});

describe('saving', () =>
{
    it('merges preference patches key by key', async () =>
    {
        await save({ action: 'preference', id: '5', patch: { thumb: 1, notes: 'a' } });
        await save({ action: 'preference', id: '5', patch: { mustKeep: true, notes: 'b' } });
        await save({ action: 'preference', id: '5', patch: { box: null } });
        expect((await load()).body.preferences['5']).toEqual({ thumb: 1, mustKeep: true, notes: 'b', box: null });
    });

    it('merges settings over the defaults', async () =>
    {
        await save({ action: 'settings', patch: { target: 50 } });
        await save({ action: 'settings', patch: { preserve: false } });
        expect((await load()).body.settings).toEqual({ ...defaults, target: 50, preserve: false });
    });

    it('replacing the collection keeps settings and preferences', async () =>
    {
        await save({ action: 'settings', patch: { target: 3 } });
        await save({ action: 'preference', id: '1', patch: { thumb: 1 } });
        const { body } = await save({ action: 'collection', games: [game('1'), game('2')] });

        expect(body.savedAt).toEqual(expect.any(String));
        const state = (await load()).body;

        expect(state.games).toHaveLength(2);
        expect(state.settings.target).toBe(3);
        expect(state.preferences['1']).toEqual({ thumb: 1 });
    });

    it('restores a backup, replacing earlier preferences', async () =>
    {
        await save({ action: 'preference', id: '1', patch: { thumb: 1 } });
        await save({
            action: 'restore',
            backup: {
                format: 'collection-cull-v1',
                games: [game('7')],
                settings: { target: 1 },
                preferences: { '7': { mustKeep: true }, '8': {} },
            },
        });
        const state = (await load()).body;

        expect(state.games.map((entry: Game) => entry.id)).toEqual(['7']);
        expect(state.preferences).toEqual({ '7': { mustKeep: true } });
        expect(state.settings.target).toBe(1);
    });

    it('rejects a backup in the wrong format without touching data', async () =>
    {
        await save({ action: 'preference', id: '1', patch: { thumb: 1 } });
        expect((await save({ action: 'restore', backup: { format: 'other' } })).status).toBe(400);
        expect((await load()).body.preferences).toEqual({ '1': { thumb: 1 } });
    });
});

describe('BGG import route', () =>
{
    const status = async (profile: string) =>
    {
        const res = await importStatus(apiRequest(`/api/bgg?profile=${profile}`));

        return { status: res.status, body: await res.json() };
    };

    // Starts an import, waits for the background work, and returns the start response and final job.
    const sync = async (profile?: string) =>
    {
        const res = await importBgg(apiRequest('/api/bgg', { method: 'POST', body: { profile } }));
        const owner = (profile ?? defaultProfile()).toLowerCase();
        const body = await res.json();

        await syncSettled(owner);

        return { status: res.status, body, job: (await status(owner)).body.job };
    };

    it('imports into the requested profile and passes its previous games', async () =>
    {
        const calls: [string, Game[]][] = [];

        mocks.fetchBgg = async (username, prev) =>
        {
            calls.push([username, prev]);

            return [game('1', { group: 'kept' })];
        };

        const first = await sync('Friend');

        expect(first.status).toBe(202);
        expect(first.body.job).toMatchObject({ status: 'running' });
        expect(first.job).toMatchObject({ status: 'done', done: 1, total: 1 });
        expect(calls[0]).toEqual(['friend', []]);
        expect((await load('friend')).body.games).toEqual([game('1', { group: 'kept' })]);

        await sync('friend');
        expect(calls[1][1]).toEqual([game('1', { group: 'kept' })]);
    });

    it('gives the default profile the bundled collection as its starting point', async () =>
    {
        let previous: Game[] = [];

        mocks.fetchBgg = async (_u, prev) =>
        {
            previous = prev;

            return [game('1')];
        };

        await sync();
        expect(previous).toHaveLength(seed.length);
    });

    it('passes BGG errors through and leaves data untouched', async () =>
    {
        mocks.fetchBgg = async () =>
        {
            throw new BggError('BoardGameGeek doesn’t recognise that username.');
        };

        expect((await sync('nobody')).job).toMatchObject({
            status: 'failed',
            message: 'BoardGameGeek doesn’t recognise that username.',
        });
        expect((await load('nobody')).body.games).toEqual([]);
    });

    it('validates what BGG returned before saving', async () =>
    {
        mocks.fetchBgg = async () => [game('1'), game('1')];
        expect((await sync('friend')).job).toMatchObject({ status: 'failed', message: 'BGG import failed. Please retry.' });
        expect((await load('friend')).body.games).toEqual([]);
    });

    it('reports progress while running, and a second start joins the running import', async () =>
    {
        let release = () =>
        {};

        let starts = 0;

        mocks.fetchBgg = async (_username, _prev, onProgress) =>
        {
            starts++;
            await onProgress?.(20, 60);
            await new Promise<void>(resolve =>
            {
                release = resolve;
            });

            return [game('1')];
        };

        await importBgg(apiRequest('/api/bgg', { method: 'POST', body: { profile: 'big' } }));
        await vi.waitFor(async () => expect((await status('big')).body.job).toMatchObject({ status: 'running', done: 20, total: 60 }));

        const again = await importBgg(apiRequest('/api/bgg', { method: 'POST', body: { profile: 'big' } }));

        expect((await again.json()).job).toMatchObject({ status: 'running', done: 20 });
        release();
        await syncSettled('big');
        expect(starts).toBe(1);
        expect((await status('big')).body.job).toMatchObject({ status: 'done', done: 1 });
    });

    it('reports an import cut off by a restart as stopped, and lets it start again', async () =>
    {
        const long = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        await db.pg.query(
            "INSERT INTO sync_jobs(owner,status,done,total,message,started,updated) VALUES('friend','running',5,60,'',$1,$1)",
            [long]
        );
        expect((await status('friend')).body.job).toMatchObject({ status: 'failed', message: expect.stringContaining('stopped') });

        mocks.fetchBgg = async () => [game('1')];
        expect((await sync('friend')).job).toMatchObject({ status: 'done' });
    });

    it('has no status for a profile that never imported, and needs sign-in', async () =>
    {
        expect((await status('fresh')).body).toEqual({ job: null });
        mocks.signedIn = false;
        expect((await status('fresh')).status).toBe(401);
    });
});

describe('price lookup route', () =>
{
    it('requires sign-in, same origin and a valid body', async () =>
    {
        expect((await lookup('cached', ['1'])).status).toBe(200);
        expect((await lookup('bogus', ['1'])).status).toBe(400);
        expect((await lookup('cached', ['abc'])).status).toBe(400);
        mocks.signedIn = false;
        expect((await lookup('cached', ['1'])).status).toBe(401);
    });

    it('only reads the cache in cached mode', async () =>
    {
        let calls = 0;

        mocks.quote = async games =>
        {
            calls++;

            return quotes(games);
        };

        expect((await lookup('cached', ['1', '2'])).body.prices).toEqual({});
        expect(calls).toBe(0);
    });

    it('looks up missing games, caches them, and skips fresh ones', async () =>
    {
        const asked: string[][] = [];
        const base = mocks.quote;

        mocks.quote = async (games, opts) =>
        {
            asked.push(games.map(entry => entry.id));

            return base(games, opts);
        };

        expect((await lookup('missing', ['1', '2'])).body.prices['2'].used.median).toBe(20);
        expect((await lookup('missing', ['1', '2', '3'])).body.prices).toMatchObject({ '1': {}, '2': {}, '3': {} });
        expect(asked).toEqual([['1', '2'], ['3']]);
        expect(Object.keys((await lookup('cached', ['1', '2', '3'])).body.prices)).toEqual(['1', '2', '3']);
    });

    it('re-checks stale prices and refreshes everything on request', async () =>
    {
        const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', ['1', JSON.stringify(quoteFor('1', old)), old]);
        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', [
            '2',
            JSON.stringify(quoteFor('2')),
            new Date().toISOString(),
        ]);
        const asked: string[][] = [];
        const base = mocks.quote;

        mocks.quote = async (games, opts) =>
        {
            asked.push(games.map(entry => entry.id));

            return base(games, opts);
        };

        await lookup('missing', ['1', '2']);
        await lookup('refresh', ['1', '2']);
        expect(asked).toEqual([['1'], ['1', '2']]);
    });

    it('rechecks prices saved before a source was available', async () =>
    {
        vi.stubEnv('BGG_API_TOKEN', 'token');
        // Checked a week ago, when only BoardGamePrices.com was set up.
        const before = { ...quoteFor('1'), sources: ['bgp'] };

        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', ['1', JSON.stringify(before), before.checkedAt]);
        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', [
            '2',
            JSON.stringify(quoteFor('2')),
            new Date().toISOString(),
        ]);
        const cached = (await lookup('cached', ['1', '2'])).body.prices;

        expect(cached['1'].due).toBe(true);
        expect(cached['2']).not.toHaveProperty('due');

        const asked: string[][] = [];
        const base = mocks.quote;

        mocks.quote = async (games, opts) =>
        {
            asked.push(games.map(entry => entry.id));

            return base(games, opts);
        };

        const after = (await lookup('missing', ['1', '2'])).body.prices;

        expect(asked).toEqual([['1']]);
        expect(after['1']).not.toHaveProperty('due');
        vi.unstubAllEnvs();
    });

    it('treats prices saved in an older format as missing', async () =>
    {
        const legacy = { used: { median: 5, low: 5, high: 5, count: 3, source: 'bgg' }, new: null, checkedAt: new Date().toISOString() };

        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', ['1', JSON.stringify(legacy), legacy.checkedAt]);
        expect((await lookup('cached', ['1'])).body.prices).toEqual({});
        expect((await lookup('missing', ['1'])).body.prices['1'].v).toBe(3);
    });

    it('identifies the site to price providers and reports sources', async () =>
    {
        let site = '';

        mocks.quote = async (games, opts) =>
        {
            site = opts.sitename;

            return { ...quotes(games), sources: ['bgg', 'bgp'], warnings: ['Some eBay lookups failed.'] };
        };

        const { body } = await lookup('missing', ['1']);

        expect(site).toBe('https://cull.test');
        expect(body).toMatchObject({ sources: ['bgg', 'bgp'], warnings: ['Some eBay lookups failed.'] });
    });

    it("doesn't cache anything when every source fails", async () =>
    {
        mocks.quote = async games => ({ ...quotes(games), sources: [], warnings: ['BoardGamePrices.com unavailable.'] });
        const res = await lookup('missing', ['1']);

        expect(res.status).toBe(502);
        expect(res.body.error).toContain('No price source could be reached');
        expect((await db.pg.query('SELECT count(*)::int AS n FROM prices')).rows[0]).toEqual({ n: 0 });
    });
});

describe('eBay description route', () =>
{
    const facts = (id: string): ListingFacts => ({
        id,
        name: `Game ${id}`,
        publisher: '',
        minPlayers: 2,
        maxPlayers: 4,
        minutes: 60,
        complexity: 2,
        similar: [],
        condition: 'Used',
    });
    const write = async (ids: string[]) =>
    {
        const res = await describe_(apiRequest('/api/ebay/descriptions', { method: 'POST', body: { games: ids.map(facts) } }));

        return { status: res.status, body: await res.json() };
    };

    it('caches fetched reviews and passes them back on the next write', async () =>
    {
        const seen: string[][] = [];

        mocks.write = async (games, opts) =>
        {
            seen.push([...(opts.cachedReviews?.keys() ?? [])]);
            const fetched = Object.fromEntries(
                games
                    .filter(gameFacts => !opts.cachedReviews?.has(gameFacts.id))
                    .map(gameFacts => [gameFacts.id, [{ subject: `Review of ${gameFacts.name}`, text: 'Loved it.' }]])
            );

            return { copies: {}, ai: true, fetchedReviews: fetched };
        };

        expect((await write(['1'])).body).toEqual({ copies: {}, ai: true });
        await write(['1', '2']);
        expect(seen).toEqual([[], ['1']]);
        const rows = (await db.pg.query<{ game_id: string }>('SELECT game_id FROM bgg_reviews ORDER BY game_id')).rows;

        expect(rows.map(row => row.game_id)).toEqual(['1', '2']);
    });

    it('ignores cached reviews older than a month', async () =>
    {
        const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();

        await db.pg.query('INSERT INTO bgg_reviews(game_id,reviews,fetched) VALUES($1,$2,$3)', [
            '1',
            JSON.stringify([{ subject: 'Old', text: 'x' }]),
            old,
        ]);
        let cached: string[] = [];

        mocks.write = async (_games, opts) =>
        {
            cached = [...(opts.cachedReviews?.keys() ?? [])];

            return { copies: {}, ai: true, fetchedReviews: {} };
        };

        await write(['1']);
        expect(cached).toEqual([]);
    });

    it('validates the request', async () =>
    {
        mocks.write = async () => ({ copies: {}, ai: false, fetchedReviews: {} });
        expect((await write([])).status).toBe(400);
        mocks.signedIn = false;
        expect((await write(['1'])).status).toBe(401);
    });
});

describe('demo visitors', () =>
{
    beforeEach(() =>
    {
        mocks.token = demoToken()!;
    });

    it('always get the sample collection with default settings', async () =>
    {
        mocks.token = sessionToken()!;
        await save({ action: 'settings', patch: { target: 5 } });
        await save({ action: 'preference', id: seed[0].id, patch: { locked: true } });
        mocks.token = demoToken()!;

        const { status, body } = await load('galeswift');

        expect(status).toBe(200);
        expect(body).toMatchObject({ demo: true, profile: 'demo', profiles: ['demo'], aiAvailable: false, savedAt: null });
        expect(body.games).toHaveLength(seed.length);
        expect(body.settings).toEqual(defaults);
        expect(body.preferences).toEqual({});
    });

    it('cannot save, import, assign groups or remove collections', async () =>
    {
        expect((await save({ action: 'settings', patch: { target: 5 } })).status).toBe(401);
        expect((await save({ profile: 'friend', action: 'remove' })).status).toBe(401);
        expect((await importBgg(apiRequest('/api/bgg', { method: 'POST', body: { profile: 'friend' } }))).status).toBe(401);
        expect((await groupsRoute(apiRequest('/api/groups', { method: 'POST', body: { profile: 'friend', ids: ['1'] } }))).status).toBe(
            401
        );
    });

    it('read saved prices but never start lookups', async () =>
    {
        await db.pg.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2,$3)', [
            '1',
            JSON.stringify(quoteFor('1')),
            new Date().toISOString(),
        ]);
        let lookups = 0;

        mocks.quote = async games =>
        {
            lookups++;

            return quotes(games);
        };

        const cached = await lookup('cached', ['1', '2']);

        expect(cached.status).toBe(200);
        expect(Object.keys(cached.body.prices)).toEqual(['1']);
        expect((await lookup('missing', ['2'])).status).toBe(403);
        expect((await lookup('refresh', ['1'])).status).toBe(403);
        expect(lookups).toBe(0);
    });

    it('get template descriptions without BGG or OpenAI calls', async () =>
    {
        let writes = 0;

        mocks.write = async () =>
        {
            writes++;

            return { copies: {}, ai: true, fetchedReviews: {} };
        };

        const facts: ListingFacts = {
            id: '7',
            name: 'Game 7',
            publisher: '',
            minPlayers: 2,
            maxPlayers: 4,
            minutes: 60,
            complexity: 2,
            similar: [],
            condition: 'Used',
        };
        const res = await describe_(apiRequest('/api/ebay/descriptions', { method: 'POST', body: { games: [facts] } }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ai).toBe(false);
        expect(body.copies['7'].source).toBe('template');
        expect(body.copies['7'].intro).toContain('Game 7');
        expect(writes).toBe(0);
    });
});

describe('removing a collection', () =>
{
    it("deletes the profile's games, choices and settings but leaves others alone", async () =>
    {
        await save({ profile: 'darkxao', action: 'collection', games: [game('10')] });
        await save({ profile: 'darkxao', action: 'preference', id: '10', patch: { thumb: 1 } });
        await save({ profile: 'darkxao', action: 'settings', patch: { target: 5 } });
        await save({ action: 'preference', id: '10', patch: { thumb: -1 } });
        expect((await load()).body.profiles).toEqual(['darkxao', 'galeswift']);

        expect((await save({ profile: 'darkxao', action: 'remove' })).status).toBe(200);
        const after = (await load()).body;

        expect(after.profiles).toEqual(['galeswift']);
        expect(after.preferences).toEqual({ '10': { thumb: -1 } });
        expect((await load('darkxao')).body).toMatchObject({ games: [], preferences: {} });
    });

    it('refuses to remove the default collection', async () =>
    {
        const res = await save({ action: 'remove' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('is the default');
    });

    it('tells the page which collection is the default', async () =>
    {
        expect((await load('someone')).body.defaultProfile).toBe('galeswift');
    });
});

describe('play groups route', () =>
{
    const assign = async (ids: string[], profile = 'friend') =>
    {
        const res = await groupsRoute(apiRequest('/api/groups', { method: 'POST', body: { profile, ids } }));

        return { status: res.status, body: await res.json() };
    };

    it('needs an OpenAI key', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', '');
        expect((await assign(['1'])).body.error).toContain('OPENAI_API_KEY');
        vi.unstubAllEnvs();
    });

    it('assigns groups only to ungrouped games and saves them', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        await save({ profile: 'friend', action: 'collection', games: [game('1'), game('2', { group: 'Kept group' }), game('3')] });
        let asked: string[] = [];
        let known: string[] = [];

        mocks.group = async (batch, existing) =>
        {
            asked = batch.map(input => input.game.id);
            known = existing;

            return { '1': 'New group', '2': 'Should not overwrite' };
        };

        const { body } = await assign(['1', '2']);

        expect(asked).toEqual(['1']);
        expect(known).toEqual(['- Kept group (1 games, e.g. Game 2)']);
        expect(body.groups).toEqual({ '1': 'New group', '2': 'Should not overwrite' });
        const games = (await load('friend')).body.games.map((entry: Game) => [entry.id, entry.group]);

        expect(games).toEqual([
            ['1', 'New group'],
            ['2', 'Kept group'],
            ['3', ''],
        ]);
        vi.unstubAllEnvs();
    });

    it('validates the request', async () =>
    {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        expect((await assign([])).status).toBe(400);
        expect((await assign(Array.from({ length: 61 }, (_, index) => String(index)))).status).toBe(400);
        mocks.signedIn = false;
        expect((await assign(['1'])).status).toBe(401);
        vi.unstubAllEnvs();
    });
});
