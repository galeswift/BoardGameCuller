import { getViewer, sameOrigin } from '../../../auth';
import { getDb } from '@/db';
import { templateCopy, writeListings, type ListingFacts, type Review } from '@/lib/listing';
import { CONDITIONS } from '@/lib/model';

export const dynamic = 'force-dynamic';
const REVIEWS_TTL_MS = 30 * 24 * 3600 * 1000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const num = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;

function valid(input: unknown): input is ListingFacts
{
    const facts = input as ListingFacts;

    return (
        !!facts &&
        typeof facts.id === 'string' &&
        /^\d{1,10}$/.test(facts.id) &&
        text(facts.name, 300) &&
        text(facts.publisher, 300) &&
        num(facts.minPlayers) &&
        num(facts.maxPlayers) &&
        num(facts.minutes) &&
        num(facts.complexity) &&
        (facts.bestPlayers === undefined || text(facts.bestPlayers, 100)) &&
        Array.isArray(facts.similar) &&
        facts.similar.length <= 5 &&
        facts.similar.every(similarName => text(similarName, 300)) &&
        CONDITIONS.includes(facts.condition)
    );
}

// Writes listing copy for up to 10 games per request; the page sends batches.
export async function POST(request: Request)
{
    const viewer = await getViewer();

    if (!viewer)
    {
        return json({ error: 'Sign in to write listings.' }, 401);
    }

    if (!sameOrigin(request))
    {
        return json({ error: 'Request origin does not match.' }, 403);
    }

    let games: ListingFacts[];

    try
    {
        games = (await request.json())?.games;
        if (!Array.isArray(games) || !games.length || games.length > 10 || !games.every(valid))
        {
            throw new Error();
        }
    }
    catch
    {
        return json({ error: 'Invalid request.' }, 400);
    }

    // The demo writes template copy only: no BGG or OpenAI calls, so it costs nothing.
    if (viewer.demo)
    {
        const copies = Object.fromEntries(games.map(facts => [facts.id, { ...templateCopy(facts), source: 'template' }]));

        return json({ copies, ai: false });
    }

    try
    {
        // BGG reviews take several paced requests per game, so they're cached for a month.
        const db = await getDb();
        const cached = (
            await db.query<{ game_id: string; reviews: Review[] }>(
                'SELECT game_id,reviews FROM bgg_reviews WHERE game_id=ANY($1) AND fetched>$2',
                [games.map(facts => facts.id), new Date(Date.now() - REVIEWS_TTL_MS).toISOString()]
            )
        ).rows;
        const { fetchedReviews, ...result } = await writeListings(games, {
            cachedReviews: new Map(cached.map(row => [row.game_id, row.reviews])),
        });
        const now = new Date().toISOString();

        for (const [id, reviews] of Object.entries(fetchedReviews))
        {
            await db.query(
                'INSERT INTO bgg_reviews(game_id,reviews,fetched) VALUES($1,$2::jsonb,$3) ON CONFLICT(game_id) DO UPDATE SET reviews=excluded.reviews,fetched=excluded.fetched',
                [id, JSON.stringify(reviews), now]
            );
        }

        return json(result);
    }
    catch (error)
    {
        console.error('Listing copy failed', error);

        return json({ error: 'Couldn’t write descriptions. Please retry.' }, 503);
    }
}
