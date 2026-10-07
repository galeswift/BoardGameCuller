import { REQUEST_GAP_MS, THING_BATCH, bggXml, sleep, type Node } from './bgg';

// Estimated resale values from two sources:
//  - BGG GeekMarket listings (thing?marketplace=1): used + new, matched by BGG ID.
//  - BoardGamePrices.com store prices: new (retail) only, matched by BGG ID.
//    Their terms: cache for at least an hour and link back where shown.
// Each source gives a USD median; the estimate averages the sources that have
// enough listings. Shipping is kept separate from the item price.
// Both are asking prices, not completed sales.

export type PriceSource = 'bgg' | 'bgp';

export type SourceEstimate = {
    source: PriceSource;
    median: number;
    low: number;
    high: number;
    count: number;
    since?: string;
    until?: string;
    shipping?: number;
    url?: string;
};

export type PriceEstimate = { median: number; low: number; high: number; count: number; shipping?: number; sources: SourceEstimate[] };

// Bump when price rules change, so quotes saved under the old rules are rechecked.
export const QUOTE_VERSION = 3;

/** `sources` lists the sources that answered when the quote was made; `due` is added on read when it needs rechecking. */
export type PriceQuote = {
    v: typeof QUOTE_VERSION;
    used: PriceEstimate | null;
    new: PriceEstimate | null;
    checkedAt: string;
    sources?: PriceSource[];
    due?: boolean;
};

export type Listing = { price: number; date?: number; shipping?: number };

type Split = { new: Listing[]; used: Listing[] };

export const MIN_LISTINGS = 3;
const RECENT_MS = 3 * 365 * 24 * 3600 * 1000;
const BGG_USED = new Set(['likenew', 'verygood', 'good', 'acceptable']);
// Seller notes that say the listing is only accessories or parts, e.g. "player mats only".
// Deliberately narrow: "Base game only, no expansions" is a real copy of the game.
const ACCESSORY_ONLY =
    /\b(?:mats?|playmats?|sleeves?|inserts?|organi[sz]ers?|promos?|tokens?|coins?|cards?|dice|box|components?|accessor(?:y|ies)|upgrades?|stickers?|minis|miniatures|meeples?)\b[^.!\n]{0,30}\bonly\b|\b(?:empty box|box only|for parts)\b/i;

export const accessoryOnly = (notes: string) => ACCESSORY_ONLY.test(notes);
// With enough store prices to anchor on, listings far below retail are
// mislabeled or partial (new below half of retail, used below 30%).
const FLOOR = { new: 0.5, used: 0.3 };
const round = (amount: number) => Math.round(amount * 100) / 100;

const medianOf = (numbers: number[]) =>
{
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = sorted.length >> 1;

    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function estimate(listings: Listing[], source: PriceSource, url?: string): SourceEstimate | null
{
    if (!listings.length)
    {
        return null;
    }

    const prices = listings.map(listing => listing.price).sort((a, b) => a - b);
    const dates = listings
        .map(listing => listing.date)
        .filter((date): date is number => date != null)
        .sort((a, b) => a - b);
    const shipping = listings.map(listing => listing.shipping).filter((cost): cost is number => cost != null);
    const day = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

    return {
        source,
        median: round(medianOf(prices)),
        low: prices[0],
        high: prices.at(-1)!,
        count: prices.length,
        ...(dates.length ? { since: day(dates[0]), until: day(dates.at(-1)!) } : {}),
        ...(shipping.length ? { shipping: round(medianOf(shipping)) } : {}),
        ...(url ? { url } : {}),
    };
}

/** Averages the sources with enough listings; if none have enough, averages them all. */
export function combine(...candidates: (SourceEstimate | null)[]): PriceEstimate | null
{
    const present = candidates.filter((candidate): candidate is SourceEstimate => !!candidate);

    if (!present.length)
    {
        return null;
    }

    const strong = present.filter(candidate => candidate.count >= MIN_LISTINGS);
    const use = strong.length ? strong : present;
    const shipping = use.map(candidate => candidate.shipping).filter((cost): cost is number => cost != null);

    return {
        median: round(use.reduce((total, candidate) => total + candidate.median, 0) / use.length),
        low: Math.min(...use.map(candidate => candidate.low)),
        high: Math.max(...use.map(candidate => candidate.high)),
        count: use.reduce((total, candidate) => total + candidate.count, 0),
        ...(shipping.length ? { shipping: round(shipping.reduce((a, b) => a + b, 0) / shipping.length) } : {}),
        sources: use,
    };
}

/** USD GeekMarket listings per game, split by new vs used. */
export async function fetchBggMarket(ids: string[]): Promise<Map<string, Split>>
{
    const out = new Map<string, Split>();

    for (let index = 0; index < ids.length; index += THING_BATCH)
    {
        if (index)
        {
            await sleep(REQUEST_GAP_MS);
        }

        const doc = await bggXml(`thing?id=${ids.slice(index, index + THING_BATCH).join(',')}&marketplace=1`);

        for (const item of doc.items?.item || [])
        {
            const split: Split = { new: [], used: [] };

            for (const marketListing of (item.marketplacelistings?.listing || []) as Node[])
            {
                const price = Number(marketListing.price?.value);
                const condition = String(marketListing.condition?.value || '');

                if (marketListing.price?.currency !== 'USD' || !(price > 0) || accessoryOnly(String(marketListing.notes?.value ?? '')))
                {
                    continue;
                }

                const date = Date.parse(marketListing.listdate?.value);
                const listing = { price, ...(Number.isFinite(date) ? { date } : {}) };

                if (condition === 'new')
                {
                    split.new.push(listing);
                }
                else if (BGG_USED.has(condition))
                {
                    split.used.push(listing);
                }
            }

            out.set(String(item.id), split);
        }
    }

    return out;
}

const bgpBase = () => process.env.BGP_API_BASE || 'https://boardgameprices.com';
const BGP_BATCH = 20;

/** In-stock US store prices per game from BoardGamePrices.com. */
export async function fetchBgp(ids: string[], sitename: string): Promise<Map<string, { listings: Listing[]; url: string }>>
{
    const out = new Map<string, { listings: Listing[]; url: string }>();

    for (let index = 0; index < ids.length; index += BGP_BATCH)
    {
        if (index)
        {
            await sleep(1000);
        }

        const params = new URLSearchParams({
            eid: ids.slice(index, index + BGP_BATCH).join(','),
            sitename,
            currency: 'USD',
            destination: 'US',
        });
        const response = await fetch(`${bgpBase()}/api/info?${params}`, { cache: 'no-store' });

        if (!response.ok)
        {
            throw new Error(`BoardGamePrices.com returned ${response.status}.`);
        }

        const data = (await response.json()) as {
            currency?: string;
            items?: {
                external_id?: string;
                url?: string;
                prices?: {
                    product?: number | string;
                    shipping?: number | string;
                    shipping_known?: boolean;
                    stock?: string;
                    country?: string;
                }[];
            }[];
        };

        if (data.currency && data.currency !== 'USD')
        {
            continue;
        }

        // One BGG ID can map to several items (editions, languages): merge them.
        for (const item of data.items || [])
        {
            if (!item.external_id)
            {
                continue;
            }

            const listings = (item.prices || [])
                .filter(offer => offer.stock === 'Y' && (offer.country ?? 'US') === 'US')
                .map(offer =>
                {
                    const shipping = Number(offer.shipping);

                    return { price: Number(offer.product), ...(offer.shipping_known && Number.isFinite(shipping) ? { shipping } : {}) };
                })
                .filter(listing => listing.price > 0);
            const existing = out.get(String(item.external_id));

            out.set(String(item.external_id), {
                listings: [...(existing?.listings ?? []), ...listings],
                url: existing?.url || (listings.length ? item.url || '' : ''),
            });
        }
    }

    return out;
}

/** Sources this server can query right now. */
export const availableSources = (): PriceSource[] => [...(process.env.BGG_API_TOKEN ? ['bgg' as const] : []), 'bgp'];

/** A quote made without a source that's available now (e.g. before a BGG token was added) should be rechecked. */
export const missesSources = (quote: PriceQuote) => !quote.sources || availableSources().some(source => !quote.sources!.includes(source));

export type QuoteResult = { quotes: Record<string, PriceQuote>; sources: PriceSource[]; warnings: string[] };

export async function quotePrices(
    games: { id: string; name: string }[],
    { sitename, now = Date.now() }: { sitename: string; now?: number }
): Promise<QuoteResult>
{
    const ids = games.map(game => game.id);
    const warnings: string[] = [];
    const sources: PriceSource[] = [];
    const [market, bgp] = await Promise.all([
        fetchBggMarket(ids)
            .then(found =>
            {
                sources.push('bgg');

                return found;
            })
            .catch(error =>
            {
                console.error('BGG prices failed', error);
                warnings.push(`BGG GeekMarket unavailable: ${error instanceof Error ? error.message : error}`);

                return new Map<string, Split>();
            }),
        fetchBgp(ids, sitename)
            .then(found =>
            {
                sources.push('bgp');

                return found;
            })
            .catch(error =>
            {
                console.error('BoardGamePrices.com failed', error);
                warnings.push('BoardGamePrices.com unavailable.');

                return new Map<string, { listings: Listing[]; url: string }>();
            }),
    ]);
    const checkedAt = new Date(now).toISOString();
    const quotes: Record<string, PriceQuote> = {};

    for (const game of games)
    {
        const split = market.get(game.id) ?? { new: [], used: [] };
        const store = bgp.get(game.id);
        const retail = store ? estimate(store.listings, 'bgp', store.url) : null;
        const anchor = retail && retail.count >= MIN_LISTINGS ? retail.median : null;
        const sane = (condition: 'new' | 'used') => (listing: Listing) => anchor == null || listing.price >= anchor * FLOOR[condition];
        const bgg = (condition: 'new' | 'used') =>
        {
            const all = split[condition].filter(sane(condition));
            const recent = estimate(
                all.filter(listing => listing.date == null || now - listing.date <= RECENT_MS),
                'bgg'
            );

            return recent && recent.count >= MIN_LISTINGS ? recent : estimate(all, 'bgg');
        };

        quotes[game.id] = {
            v: QUOTE_VERSION,
            checkedAt,
            sources: [...sources].sort(),
            used: combine(bgg('used')),
            new: combine(bgg('new'), retail),
        };
    }

    return { quotes, sources, warnings };
}
