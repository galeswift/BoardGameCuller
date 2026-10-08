import { getUser, sameOrigin } from '../../auth';
import { getDb } from '@/db';
import { resolveProfile } from '@/lib/profile';
import { readSyncJob, startSync } from '@/lib/sync-jobs';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

// Starts importing the profile's owned games from BoardGameGeek in the background, replacing its
// stored collection when done. Answers 202 with the import's progress; GET polls it.
export async function POST(request: Request)
{
    const user = await getUser();

    if (!user)
    {
        return json({ error: 'Sign in before importing.' }, 401);
    }

    if (!sameOrigin(request))
    {
        return json({ error: 'Request origin does not match.' }, 403);
    }

    let profile;

    try
    {
        profile = resolveProfile((await request.json())?.profile);
    }
    catch (error)
    {
        return json({ error: error instanceof Error && error.message.startsWith('Invalid') ? error.message : 'Invalid request.' }, 400);
    }

    try
    {
        return json({ job: await startSync(await getDb(), profile) }, 202);
    }
    catch (error)
    {
        console.error('BGG import could not start', error);

        return json({ error: 'BGG import could not start. Please retry.' }, 503);
    }
}

// The profile's latest import: running (with progress), done or failed. Null if it never had one.
export async function GET(request: Request)
{
    const user = await getUser();

    if (!user)
    {
        return json({ error: 'Sign in to see imports.' }, 401);
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
        return json({ job: await readSyncJob(await getDb(), profile) });
    }
    catch (error)
    {
        console.error('BGG import status failed', error);

        return json({ error: 'Import status is temporarily unavailable.' }, 503);
    }
}
