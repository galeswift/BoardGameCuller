import type { Pool } from 'pg';
import seed from './collection.json';
import { BggError, fetchBggCollection } from './bgg';
import type { Game } from './model';
import { defaultProfile } from './profile';
import { validateGames } from './validation';

// Importing a big collection takes minutes (BGG serves 20 games per request, 2 seconds apart),
// so imports run in the background. Their progress lives in the database, so the page can
// poll it and pick it up again after a reload.
export type SyncJob = {
    status: 'running' | 'done' | 'failed';
    done: number;
    total: number;
    message: string;
    started: string;
    updated: string;
};

// A running import reports progress every few seconds. One silent for this long was cut off,
// usually by a server restart or deploy.
const STALE_MS = 3 * 60 * 1000;

// Imports running in this server process, by profile.
const running = new Map<string, Promise<void>>();

export async function readSyncJob(db: Pool, owner: string): Promise<SyncJob | null>
{
    const job = (await db.query<SyncJob>('SELECT status,done,total,message,started,updated FROM sync_jobs WHERE owner=$1', [owner]))
        .rows[0];

    if (!job)
    {
        return null;
    }

    if (job.status === 'running' && !running.has(owner) && Date.now() - Date.parse(job.updated) > STALE_MS)
    {
        return { ...job, status: 'failed', message: 'The import stopped before it finished. Start it again.' };
    }

    return job;
}

/** Starts importing the profile's collection from BGG, or returns the import already under way. */
export async function startSync(db: Pool, owner: string): Promise<SyncJob>
{
    const current = await readSyncJob(db, owner);

    if (running.has(owner) || current?.status === 'running')
    {
        return current!;
    }

    const now = new Date().toISOString();

    await db.query(
        "INSERT INTO sync_jobs(owner,status,done,total,message,started,updated) VALUES($1,'running',0,0,'',$2,$2) ON CONFLICT(owner) DO UPDATE SET status='running',done=0,total=0,message='',started=$2,updated=$2",
        [owner, now]
    );

    const work = runSync(db, owner).finally(() => running.delete(owner));

    running.set(owner, work);

    return (await readSyncJob(db, owner))!;
}

/** Resolves when the profile's import (if any) in this process has finished. */
export function syncSettled(owner: string): Promise<void>
{
    return running.get(owner) ?? Promise.resolve();
}

async function runSync(db: Pool, owner: string)
{
    try
    {
        const prior =
            (await db.query<{ games: Game[] | null }>('SELECT games FROM collection_state WHERE owner=$1', [owner])).rows[0]?.games ??
            (owner === defaultProfile() ? (seed as Game[]) : []);
        const fetched = await fetchBggCollection(owner, prior, async (done, total) =>
        {
            await db.query('UPDATE sync_jobs SET done=$2,total=$3,updated=$4 WHERE owner=$1', [
                owner,
                done,
                total,
                new Date().toISOString(),
            ]);
        });
        const games = validateGames(fetched);
        const now = new Date().toISOString();

        await db.query(
            "INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,'{}',$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET games=excluded.games,updated=excluded.updated",
            [owner, JSON.stringify(games), now]
        );
        await db.query("UPDATE sync_jobs SET status='done',done=$2,total=$2,updated=$3 WHERE owner=$1", [owner, games.length, now]);
    }
    catch (error)
    {
        if (!(error instanceof BggError))
        {
            console.error('BGG import failed', error);
        }

        const message = error instanceof BggError ? error.message : 'BGG import failed. Please retry.';

        await db
            .query("UPDATE sync_jobs SET status='failed',message=$2,updated=$3 WHERE owner=$1", [owner, message, new Date().toISOString()])
            .catch(updateError => console.error('Could not record the failed import', updateError));
    }
}
