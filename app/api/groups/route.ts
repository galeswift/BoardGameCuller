import { getUser, sameOrigin } from '../../auth';
import { getDb } from '@/db';
import seed from '@/lib/collection.json';
import { fetchThingDetails } from '@/lib/bgg';
import { GROUP_BATCH, assignGroups, vocabulary } from '@/lib/groups';
import type { Game } from '@/lib/model';
import { aiConfigured } from '@/lib/openai';
import { defaultProfile, resolveProfile } from '@/lib/profile';

export const dynamic = 'force-dynamic';

function json(value: unknown, status = 200)
{
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function loadGames(profile: string): Promise<Game[]>
{
    const db = await getDb();
    const row = (await db.query<{ games: Game[] | null }>('SELECT games FROM collection_state WHERE owner=$1', [profile])).rows[0];
    return row?.games ?? (profile === defaultProfile() ? (seed as Game[]) : []);
}

// Assigns play groups to one batch of a profile's games (the page sends batches
// so it can show progress). Games that already have a group are left alone.
export async function POST(request: Request)
{
    if (!(await getUser()))
    {
        return json({ error: 'Sign in to assign play groups.' }, 401);
    }
    if (!sameOrigin(request))
    {
        return json({ error: 'Request origin does not match.' }, 403);
    }
    if (!aiConfigured())
    {
        return json({ error: 'Assigning play groups needs OPENAI_API_KEY on the server.' }, 400);
    }

    let profile: string;
    let ids: string[];
    try
    {
        const body = await request.json();
        profile = resolveProfile(body?.profile);
        ids = body?.ids;
        if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > GROUP_BATCH ||
            !ids.every(id => typeof id === 'string' && /^\d{1,10}$/.test(id))
        )
        {
            throw new Error();
        }
    }
    catch
    {
        return json({ error: 'Invalid request.' }, 400);
    }

    try
    {
        const games = await loadGames(profile);
        const wanted = new Set(ids);
        const targets = games.filter(game => wanted.has(game.id) && game.type === 'standalone' && !game.group);
        if (!targets.length)
        {
            return json({ groups: {} });
        }

        // Categories and mechanics make the grouping much better, but it can still run without them.
        const details = await fetchThingDetails(targets.map(game => game.id)).catch(error =>
        {
            console.error('BGG details for play groups failed', error);
            return new Map();
        });
        const groups = await assignGroups(
            targets.map(game => ({ game, details: details.get(game.id) })),
            vocabulary(games)
        );

        // Re-read before saving so changes made meanwhile aren't lost, and never overwrite a group.
        const latest = await loadGames(profile);
        const updated = latest.map(game => (groups[game.id] && !game.group ? { ...game, group: groups[game.id] } : game));
        const db = await getDb();
        await db.query(
            "INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,'{}',$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET games=excluded.games,updated=excluded.updated",
            [profile, JSON.stringify(updated), new Date().toISOString()]
        );
        return json({ groups });
    }
    catch (error)
    {
        console.error('Assigning play groups failed', error);
        return json({ error: 'Couldn’t assign play groups. Please retry.' }, 503);
    }
}
