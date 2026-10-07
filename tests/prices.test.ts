import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    accessoryOnly,
    availableSources,
    combine,
    estimate,
    fetchBgp,
    fetchBggMarket,
    missesSources,
    quotePrices,
    type PriceQuote,
    type SourceEstimate,
} from '@/lib/prices';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const SITE = { sitename: 'https://cull.test', now: NOW };
const day = (iso: string) => new Date(iso).toUTCString();
const listing = (condition: string, price: string, date: string, currency = 'USD') =>
    `<listing><listdate value="${day(date)}"/><price currency="${currency}" value="${price}"/><condition value="${condition}"/><notes value=""/></listing>`;
const marketXml = (items: Record<string, string[]>) =>
    `<?xml version="1.0" encoding="utf-8"?><items>${Object.entries(items)
        .map(([id, listings]) => `<item type="boardgame" id="${id}"><marketplacelistings>${listings.join('')}</marketplacelistings></item>`)
        .join('')}</items>`;

type StorePrice = { product: number; shipping: number | string; shipping_known: boolean; stock: string };
const bgpJson = (items: Record<string, StorePrice[]>) =>
    Response.json({
        currency: 'USD',
        items: Object.entries(items).map(([eid, prices]) => ({
            external_id: eid,
            url: `https://boardgameprices.com/item/show/${eid}`,
            prices,
        })),
    });
const store = (product: number, shipping: number | string = 0, shipping_known = true, stock = 'Y'): StorePrice => ({
    product,
    shipping,
    shipping_known,
    stock,
});

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

async function run<T>(promise: Promise<T>)
{
    promise.catch(() =>
    {});
    await vi.runAllTimersAsync();

    return promise;
}

/** Routes fake responses by host. */
function serve({ bgg = marketXml({}), bgp = bgpJson({}) }: { bgg?: string; bgp?: Response })
{
    fetchMock.mockImplementation(async url =>
    {
        if (url.includes('boardgamegeek'))
        {
            return new Response(bgg);
        }

        if (url.includes('boardgameprices'))
        {
            return bgp.clone();
        }

        throw new Error(`unexpected ${url}`);
    });
}

beforeEach(() =>
{
    vi.useFakeTimers();
    vi.stubEnv('BGG_API_TOKEN', 'token');
    fetchMock = vi.fn();
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

describe('estimate', () =>
{
    it('takes the median, range, dates and median shipping', () =>
    {
        expect(estimate([{ price: 30, shipping: 8 }, { price: 10 }, { price: 200, shipping: 12 }], 'bgp')).toEqual({
            source: 'bgp',
            median: 30,
            low: 10,
            high: 200,
            count: 3,
            shipping: 10,
        });
        expect(
            estimate(
                [
                    { price: 5, date: Date.parse('2025-03-02') },
                    { price: 6, date: Date.parse('2024-01-09') },
                ],
                'bgg'
            )
        ).toMatchObject({ median: 5.5, since: '2024-01-09', until: '2025-03-02' });
        expect(estimate([], 'bgg')).toBeNull();
    });
});

describe('combine', () =>
{
    const makeEstimate = (source: SourceEstimate['source'], median: number, count: number, shipping?: number): SourceEstimate => ({
        source,
        median,
        low: median - 5,
        high: median + 5,
        count,
        ...(shipping != null ? { shipping } : {}),
    });

    it('averages every source with enough listings', () =>
    {
        expect(combine(makeEstimate('bgg', 20, 4, 8), makeEstimate('bgp', 40, 25, 6))).toMatchObject({
            median: 30,
            low: 15,
            high: 45,
            count: 29,
            shipping: 7,
        });
    });
    it('leaves out thin sources when a well-supported one exists', () =>
    {
        const combined = combine(makeEstimate('bgg', 99, 1), makeEstimate('bgp', 30, 5));

        expect(combined).toMatchObject({ median: 30, count: 5 });
        expect(combined!.sources.map(sourceEstimate => sourceEstimate.source)).toEqual(['bgp']);
    });
    it('averages thin sources when nothing is well supported', () =>
    {
        expect(combine(makeEstimate('bgg', 20, 1), null, makeEstimate('bgp', 40, 2))).toMatchObject({ median: 30, count: 3 });
        expect(combine(null, null)).toBeNull();
    });
    it('omits shipping when no source knows it', () =>
    {
        expect(combine(makeEstimate('bgg', 20, 3))).not.toHaveProperty('shipping');
    });
});

describe('fetchBggMarket', () =>
{
    it('keeps USD listings and splits new from used', async () =>
    {
        serve({
            bgg: marketXml({
                '1': [
                    listing('new', '40', '2026-01-01'),
                    listing('likenew', '30', '2026-02-01'),
                    listing('acceptable', '15', '2025-02-01'),
                    listing('verygood', '25', '2026-03-01', 'EUR'),
                    listing('new', '0', '2026-01-01'),
                ],
            }),
        });
        const split = (await run(fetchBggMarket(['1']))).get('1')!;

        expect(split.new.map(entry => entry.price)).toEqual([40]);
        expect(split.used.map(entry => entry.price)).toEqual([30, 15]);
        expect(fetchMock.mock.calls[0][0]).toContain('thing?id=1&marketplace=1');
    });
});

describe('fetchBgp', () =>
{
    it('keeps in-stock store prices with known shipping, by BGG ID', async () =>
    {
        serve({
            bgp: bgpJson({
                '13': [
                    store(29.99, '5.00'),
                    store(39.99, '6.99'),
                    store(45, 0, false),
                    store(19.99, '4.00', true, 'N'),
                    store(25, 0, true, '?'),
                ],
            }),
        });
        const result = (await run(fetchBgp(['13'], 'https://cull.test'))).get('13')!;

        expect(result.listings).toEqual([{ price: 29.99, shipping: 5 }, { price: 39.99, shipping: 6.99 }, { price: 45 }]);
        expect(result.url).toBe('https://boardgameprices.com/item/show/13');
        const url = new URL(fetchMock.mock.calls[0][0]);

        expect(Object.fromEntries(url.searchParams)).toEqual({
            eid: '13',
            sitename: 'https://cull.test',
            currency: 'USD',
            destination: 'US',
        });
    });
});

describe('quotePrices', () =>
{
    it('uses GeekMarket for used, averages it with store prices for new, and keeps shipping separate', async () =>
    {
        serve({
            bgg: marketXml({
                '1': [
                    listing('good', '20', '2026-01-01'),
                    listing('good', '30', '2026-02-01'),
                    listing('good', '40', '2026-03-01'),
                    listing('new', '50', '2026-03-01'),
                    listing('new', '52', '2026-04-01'),
                    listing('new', '54', '2026-05-01'),
                ],
            }),
            bgp: bgpJson({ '1': [store(40, '6.00'), store(42, '6.00'), store(44, '8.00')] }),
        });
        const out = await run(quotePrices([{ id: '1', name: 'Heat: Pedal to the Metal' }], SITE));

        expect(out.sources.sort()).toEqual(['bgg', 'bgp']);
        const quote = out.quotes['1'];

        expect(quote).toMatchObject({ v: 3, checkedAt: new Date(NOW).toISOString(), sources: ['bgg', 'bgp'] });
        // Used: GeekMarket only; it has no shipping data.
        expect(quote.used).toMatchObject({ median: 30, count: 3 });
        expect(quote.used).not.toHaveProperty('shipping');
        // New: GeekMarket 52 and stores 42 → 47; shipping comes from the stores.
        expect(quote.new).toMatchObject({ median: 47, shipping: 6, count: 6 });
        expect(quote.new!.sources.find(sourceEstimate => sourceEstimate.source === 'bgp')).toMatchObject({
            median: 42,
            url: 'https://boardgameprices.com/item/show/1',
        });
    });

    it('only queries BGG and BoardGamePrices.com', async () =>
    {
        serve({
            bgg: marketXml({ '1': [listing('good', '14', '2026-01-01')] }),
            bgp: bgpJson({ '1': [store(40, '5.00'), store(44, '5.00'), store(48, '5.00')] }),
        });
        const out = await run(quotePrices([{ id: '1', name: 'Game' }], SITE));

        expect(out.quotes['1'].used).toMatchObject({ median: 14, count: 1 });
        expect(out.quotes['1'].new).toMatchObject({ median: 44, shipping: 5 });
        expect(fetchMock.mock.calls.every(([url]) => /boardgamegeek|boardgameprices/.test(url))).toBe(true);
    });

    it('prefers recent GeekMarket listings, falling back to older ones', async () =>
    {
        serve({
            bgg: marketXml({
                '1': [
                    listing('good', '20', '2026-01-01'),
                    listing('good', '30', '2026-02-01'),
                    listing('good', '40', '2026-03-01'),
                    listing('good', '99', '2019-01-01'),
                ],
                '2': [listing('good', '15', '2018-01-01'), listing('good', '25', '2019-01-01')],
            }),
        });
        const out = await run(
            quotePrices(
                [
                    { id: '1', name: 'A' },
                    { id: '2', name: 'B' },
                ],
                SITE
            )
        );

        expect(out.quotes['1'].used).toMatchObject({ median: 30, count: 3 });
        expect(out.quotes['2'].used).toMatchObject({ median: 20, count: 2 });
    });

    it('carries on when a source fails, and reports it', async () =>
    {
        serve({ bgg: marketXml({ '1': [listing('good', '12', '2026-01-01')] }), bgp: new Response('down', { status: 503 }) });
        const out = await run(quotePrices([{ id: '1', name: 'Game' }], SITE));

        expect(out.sources).toEqual(['bgg']);
        expect(out.warnings).toEqual(['BoardGamePrices.com unavailable.']);
        expect(out.quotes['1'].used).toMatchObject({ median: 12 });
    });

    it('reports BGG being unavailable without failing the other sources', async () =>
    {
        vi.stubEnv('BGG_API_TOKEN', '');
        serve({ bgp: bgpJson({ '1': [store(40, '5.00')] }) });
        const out = await run(quotePrices([{ id: '1', name: 'Game' }], SITE));

        expect(out.sources).toEqual(['bgp']);
        expect(out.warnings[0]).toContain('BGG GeekMarket unavailable');
        expect(out.quotes['1']).toMatchObject({ used: null, new: { median: 40 } });
    });
});

describe('missesSources', () =>
{
    const quote = (sources?: PriceQuote['sources']): PriceQuote => ({
        v: 3,
        used: null,
        new: null,
        checkedAt: '2026-10-01T00:00:00Z',
        ...(sources ? { sources } : {}),
    });

    it("flags quotes made without a source that's available now", () =>
    {
        expect(availableSources()).toEqual(['bgg', 'bgp']);
        expect(missesSources(quote(['bgp']))).toBe(true);
        expect(missesSources(quote(['bgg', 'bgp']))).toBe(false);
        expect(missesSources(quote())).toBe(true);
    });
    it('follows configuration: without a BGG token only store prices are available', () =>
    {
        vi.stubEnv('BGG_API_TOKEN', '');
        expect(availableSources()).toEqual(['bgp']);
        expect(missesSources(quote(['bgp']))).toBe(false);
    });
    it('records which sources answered', async () =>
    {
        serve({ bgp: new Response('down', { status: 503 }) });
        const out = await run(quotePrices([{ id: '1', name: 'Game' }], SITE));

        expect(out.quotes['1'].sources).toEqual(['bgg']);
        expect(missesSources(out.quotes['1'])).toBe(true);
    });
});

describe('accessoryOnly', () =>
{
    it('spots listings for accessories or parts', () =>
    {
        expect(accessoryOnly('See images. This is for the dual layer player mats only. They keep the cubes from sliding.')).toBe(true);
        expect(accessoryOnly('Sleeves only, no game')).toBe(true);
        expect(accessoryOnly('Box only - no components')).toBe(true);
        expect(accessoryOnly('Selling for parts')).toBe(true);
        expect(accessoryOnly('Promo cards only')).toBe(true);
    });
    it('keeps real copies of the game', () =>
    {
        expect(accessoryOnly('KS edition - Base game only with Foil Card replacements. No expansions.')).toBe(false);
        expect(accessoryOnly('Cards sleeved. Only played once.')).toBe(false);
        expect(accessoryOnly('Complete, includes insert and promos')).toBe(false);
        expect(accessoryOnly('')).toBe(false);
    });
});

describe('bad data', () =>
{
    it("skips GeekMarket listings whose notes say they're accessories only", async () =>
    {
        const mats = `<listing><listdate value="${day('2026-09-15')}"/><price currency="USD" value="10.00"/><condition value="new"/><notes value="This is for the dual layer player mats only."/></listing>`;

        serve({ bgg: marketXml({ '1': [mats, listing('new', '24', '2026-05-01')] }) });
        expect((await run(fetchBggMarket(['1']))).get('1')!.new.map(entry => entry.price)).toEqual([24]);
    });

    it('merges every BoardGamePrices.com item for a BGG ID and keeps US stores only', async () =>
    {
        serve({
            bgp: Response.json({
                currency: 'USD',
                items: [
                    {
                        external_id: '1',
                        url: 'https://bgp/item/a',
                        prices: [
                            { ...store(14.99, '6.99'), country: 'US' },
                            { ...store(24.54, '10.52'), country: 'CA' },
                        ],
                    },
                    {
                        external_id: '1',
                        url: 'https://bgp/item/b',
                        prices: [
                            { ...store(20.97, '5.00'), country: 'US' },
                            { ...store(38.03), country: 'DE' },
                        ],
                    },
                    { external_id: '1', url: 'https://bgp/item/c', prices: [] },
                ],
            }),
        });
        const result = (await run(fetchBgp(['1'], 'https://cull.test'))).get('1')!;

        expect(result.listings.map(entry => entry.price)).toEqual([14.99, 20.97]);
        expect(result.url).toBe('https://bgp/item/a');
    });

    it('drops listings far below the store price once there are enough store prices', async () =>
    {
        serve({
            bgg: marketXml({
                '1': ['9', '38', '39', '41']
                    .map(price => listing('new', price, '2026-05-01'))
                    .concat(['8', '20', '22', '24'].map(price => listing('good', price, '2026-05-01'))),
            }),
            bgp: bgpJson({ '1': [store(36, '5.00'), store(40, '5.00'), store(44, '5.00')] }),
        });
        const quote = (await run(quotePrices([{ id: '1', name: 'Game' }], SITE))).quotes['1'];

        // New floor is half of $40 retail ($20): the $9 listing goes. Used floor is 30% ($12): the $8 one goes.
        expect(quote.new!.sources.find(sourceEstimate => sourceEstimate.source === 'bgg')).toMatchObject({ count: 3, median: 39 });
        expect(quote.new).toMatchObject({ median: 39.5 });
        expect(quote.used).toMatchObject({ median: 22, count: 3 });
    });

    it("keeps cheap listings when there's no store price to compare against", async () =>
    {
        serve({ bgg: marketXml({ '1': [listing('good', '8', '2026-05-01')] }) });
        expect((await run(quotePrices([{ id: '1', name: 'Game' }], SITE))).quotes['1'].used).toMatchObject({ median: 8 });
    });
});
