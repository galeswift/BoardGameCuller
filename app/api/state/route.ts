import { getUser, sameOrigin } from '../../auth';
import { getDb } from '@/db';
import seed from '@/lib/collection.json';
import { defaults, type Game, type Preference, type Settings } from '@/lib/model';
import { preferencePatch, settingsPatch, validateGames } from '@/lib/validation';
import { preferenceWrite } from '@/lib/preference-sql';
import { defaultProfile, resolveProfile } from '@/lib/profile';
import { aiConfigured } from '@/lib/openai';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request)
{
    const user = await getUser();

    if (!user)
    {
        return json({ error: 'Sign in to load your saved collection.' }, 401);
    }

    let profile;

    try
    {
        profile = resolveProfile(new URL(request.url).searchParams.get('profile'));
    }
    catch (error)
    {
        return json({ error: (error as Error).message }, 400);
    }

    try
    {
        const db = await getDb();
        const [state, prefs, owners] = await Promise.all([
            db.query<{ settings: Partial<Settings>; games: Game[] | null; updated: string }>(
                'SELECT settings,games,updated FROM collection_state WHERE owner=$1',
                [profile]
            ),
            db.query<{ game_id: string; data: Preference; updated: string }>(
                'SELECT game_id,data,updated FROM preferences WHERE owner=$1',
                [profile]
            ),
            db.query<{ owner: string }>('SELECT owner FROM collection_state ORDER BY owner'),
        ]);
        const saved = state.rows[0];
        const timestamps = [saved?.updated, ...prefs.rows.map(row => row.updated)].filter(Boolean).sort();

        return json({
            profile,
            defaultProfile: defaultProfile(),
            aiAvailable: aiConfigured(),
            profiles: [...new Set([defaultProfile(), ...owners.rows.map(row => row.owner)])].sort(),
            games: saved?.games ?? (profile === defaultProfile() ? seed : []),
            settings: { ...defaults, ...saved?.settings },
            preferences: Object.fromEntries(prefs.rows.map(row => [row.game_id, row.data])),
            savedAt: timestamps.at(-1) || null,
        });
    }
    catch (error)
    {
        console.error('Collection load failed', error);

        return json({ error: 'Your saved collection is temporarily unavailable. Please retry.' }, 503);
    }
}

export async function POST(request: Request)
{
    const user = await getUser();

    if (!user)
    {
        return json({ error: 'Sign in before saving preferences.' }, 401);
    }

    if (!sameOrigin(request))
    {
        return json({ error: 'Request origin does not match.' }, 403);
    }

    if (Number(request.headers.get('content-length') || 0) > 1500000)
    {
        return json({ error: 'Import is too large.' }, 413);
    }

    let payload;

    try
    {
        const text = await request.text();

        if (text.length > 1500000)
        {
            return json({ error: 'Import is too large.' }, 413);
        }

        payload = JSON.parse(text);
    }
    catch
    {
        return json({ error: 'Invalid request.' }, 400);
    }

    try
    {
        const db = await getDb();
        const now = new Date().toISOString();
        const owner = resolveProfile(payload.profile);
        const preferenceStatement = (id: string, rawPatch: unknown) =>
        {
            if (typeof id !== 'string' || !/^\d{1,10}$/.test(id))
            {
                throw new Error('Invalid BGG ID.');
            }

            const patch = preferencePatch(rawPatch);

            if (!Object.keys(patch).length)
            {
                throw new Error('Invalid empty preference.');
            }

            return preferenceWrite(owner, id, patch as Record<string, unknown>, now);
        };

        if (payload.action === 'preference')
        {
            const statement = preferenceStatement(payload.id, payload.patch);

            await db.query(statement.sql, statement.values);
        }
        else if (payload.action === 'settings')
        {
            const patch = settingsPatch(payload.patch);

            await db.query(
                'INSERT INTO collection_state(owner,settings,updated) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET settings=collection_state.settings||excluded.settings,updated=excluded.updated',
                [owner, JSON.stringify(patch), now]
            );
        }
        else if (payload.action === 'collection')
        {
            const games = validateGames(payload.games);

            await db.query(
                "INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,'{}',$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET games=excluded.games,updated=excluded.updated",
                [owner, JSON.stringify(games), now]
            );
        }
        else if (payload.action === 'restore')
        {
            const backup = payload.backup;

            if (backup?.format !== 'collection-cull-v1')
            {
                throw new Error('Choose a Collection Cull backup.');
            }

            const games = validateGames(backup.games);
            const restoredSettings = settingsPatch(backup.settings);
            const prefs = backup.preferences;

            if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || Object.keys(prefs).length > 2000)
            {
                throw new Error('Invalid preferences backup.');
            }

            const statements = [
                {
                    sql: 'INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,$2::jsonb,$3::jsonb,$4) ON CONFLICT(owner) DO UPDATE SET settings=excluded.settings,games=excluded.games,updated=excluded.updated',
                    values: [owner, JSON.stringify(restoredSettings), JSON.stringify(games), now],
                },
                { sql: 'DELETE FROM preferences WHERE owner=$1', values: [owner] },
                ...Object.entries(prefs)
                    .filter(([, patch]) => Object.keys(patch as object).length > 0)
                    .map(([id, patch]) => preferenceStatement(id, patch)),
            ];
            const client = await db.connect();

            try
            {
                await client.query('BEGIN');
                for (const statement of statements)
                {
                    await client.query(statement.sql, statement.values);
                }

                await client.query('COMMIT');
            }
            catch (error)
            {
                await client.query('ROLLBACK');
                throw error;
            }
            finally
            {
                client.release();
            }
        }
        else if (payload.action === 'remove')
        {
            // Deletes this app's copy of a collection (games, choices, settings). BGG isn't touched.
            if (owner === defaultProfile())
            {
                throw new Error('Collection ' + owner + ' is the default and can’t be removed.');
            }

            const client = await db.connect();

            try
            {
                await client.query('BEGIN');
                await client.query('DELETE FROM preferences WHERE owner=$1', [owner]);
                await client.query('DELETE FROM collection_state WHERE owner=$1', [owner]);
                await client.query('COMMIT');
            }
            catch (error)
            {
                await client.query('ROLLBACK');
                throw error;
            }
            finally
            {
                client.release();
            }
        }
        else
        {
            throw new Error('Unknown action.');
        }

        return json({ savedAt: now });
    }
    catch (error)
    {
        const msg = error instanceof Error ? error.message : '';

        if (/Invalid|Unknown|must|too long|Choose|Collection|Duplicate|Target/.test(msg))
        {
            return json({ error: msg }, 400);
        }

        console.error('Preference save failed', error);

        return json({ error: 'Saving failed. Your changes are still on this page. Retry to save them.' }, 503);
    }
}
