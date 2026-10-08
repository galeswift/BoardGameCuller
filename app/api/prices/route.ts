import { getViewer, sameOrigin } from '../../auth';
import { getDb } from '@/db';
import { BggError } from '@/lib/bgg';
import { MAX_COLLECTION_GAMES } from '@/lib/model';
import { QUOTE_VERSION, missesSources, quotePrices, type PriceQuote } from '@/lib/prices';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const STALE_MS = 14 * 24 * 3600 * 1000;

// Prices are per game, not per profile, so the cache is shared.
// mode: 'cached' reads the cache only; 'missing' looks up absent or stale games; 'refresh' looks up all.
export async function POST(request: Request)
{
    const viewer = await getViewer();

    if (!viewer)
    {
        return json({ error: 'Sign in to check prices.' }, 401);
    }

    if (!sameOrigin(request))
    {
        return json({ error: 'Request origin does not match.' }, 403);
    }

    let games: { id: string; name: string }[];
    let mode: string;

    try
    {
        const body = await request.json();

        mode = body?.mode;
        games = body?.games;
        if (
            !['cached', 'missing', 'refresh'].includes(mode) ||
            !Array.isArray(games) ||
            games.length > MAX_COLLECTION_GAMES ||
            !games.every(
                game =>
                    typeof game?.id === 'string' && /^\d{1,10}$/.test(game.id) && typeof game.name === 'string' && game.name.length <= 300
            )
        )
        {
            throw new Error();
        }
    }
    catch
    {
        return json({ error: 'Invalid request.' }, 400);
    }

    // The demo can read saved prices but never triggers new lookups.
    if (viewer.demo && mode !== 'cached')
    {
        return json({ error: 'The demo shows saved prices only.' }, 403);
    }

    try
    {
        const db = await getDb();
        const ids = games.map(game => game.id);
        const rows = (
            await db.query<{ game_id: string; quote: PriceQuote; checked: string }>(
                'SELECT game_id,quote,checked FROM prices WHERE game_id=ANY($1)',
                [ids]
            )
        ).rows;
        // Quotes saved in an older format are treated as missing.
        const current = rows.filter(row => row.quote?.v === QUOTE_VERSION);
        // Flag quotes made before a now-available source was set up, so the page rechecks them.
        const prices: Record<string, PriceQuote> = Object.fromEntries(
            current.map(row => [row.game_id, missesSources(row.quote) ? { ...row.quote, due: true } : row.quote])
        );
        let sources: string[] = [];
        let warnings: string[] = [];

        if (mode !== 'cached')
        {
            const fresh = new Set(
                current.filter(row => Date.now() - Date.parse(row.checked) < STALE_MS && !missesSources(row.quote)).map(row => row.game_id)
            );
            const todo = mode === 'refresh' ? games : games.filter(game => !fresh.has(game.id));

            if (todo.length)
            {
                // BoardGamePrices.com asks callers to identify their site.
                const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
                const sitename = process.env.SITE_URL || `${request.headers.get('x-forwarded-proto') || 'https'}://${host}`;
                const result = await quotePrices(todo, { sitename });

                ({ sources, warnings } = result);
                // Don't cache empty quotes when every source failed.
                if (!sources.length)
                {
                    return json({ error: `No price source could be reached. ${warnings.join(' ')}`.trim() }, 502);
                }

                const quotes = result.quotes;

                for (const [id, quote] of Object.entries(quotes))
                {
                    prices[id] = quote;
                    await db.query(
                        'INSERT INTO prices(game_id,quote,checked) VALUES($1,$2::jsonb,$3) ON CONFLICT(game_id) DO UPDATE SET quote=excluded.quote,checked=excluded.checked',
                        [id, JSON.stringify(quote), quote.checkedAt]
                    );
                }
            }
        }

        return json({ prices, sources, warnings });
    }
    catch (error)
    {
        if (error instanceof BggError)
        {
            return json({ error: error.message }, 502);
        }

        console.error('Price lookup failed', error);

        return json({ error: 'Price lookup failed. Please retry.' }, 503);
    }
}
