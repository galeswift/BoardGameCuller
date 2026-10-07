import { cookies } from 'next/headers';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Shared password gate. Data is partitioned by profile (BGG username), not by who signed in.
// There's also a demo session for visitors: it can only read the sample collection
// and saved prices, so `getUser()` (owner only) keeps guarding everything else.
export type AppUser = { signedIn: true };

export type Viewer = { demo: boolean };

export const DEMO_MAX_AGE = 60 * 60 * 24;

export const SESSION_COOKIE = 'cc_session';

export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function password(): string | null
{
    return process.env.APP_PASSWORD || null;
}

// Derived from the password, so changing APP_PASSWORD signs out every session.
export function sessionToken(): string | null
{
    const secret = password();

    if (!secret)
    {
        return null;
    }

    return createHmac('sha256', secret).update('collection-cull-session-v1').digest('hex');
}

// A different value from the owner's, signed the same way, so it can't be forged or upgraded.
export function demoToken(): string | null
{
    const secret = password();

    if (!secret)
    {
        return null;
    }

    return createHmac('sha256', secret).update('collection-cull-demo-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean
{
    const actualHash = createHash('sha256').update(a).digest();
    const expectedHash = createHash('sha256').update(b).digest();

    return timingSafeEqual(actualHash, expectedHash);
}

export function passwordMatches(input: string): boolean
{
    const secret = password();

    return !!secret && safeEqual(input, secret);
}

export async function getUser(): Promise<AppUser | null>
{
    const expected = sessionToken();
    const cookie = (await cookies()).get(SESSION_COOKIE)?.value;

    if (!expected || !cookie || !safeEqual(cookie, expected))
    {
        return null;
    }

    return { signedIn: true };
}

/** The owner or a demo visitor. Only for routes that are safe for the demo. */
export async function getViewer(): Promise<Viewer | null>
{
    const cookie = (await cookies()).get(SESSION_COOKIE)?.value;

    if (!cookie)
    {
        return null;
    }

    const owner = sessionToken();

    if (owner && safeEqual(cookie, owner))
    {
        return { demo: false };
    }

    const demo = demoToken();

    if (demo && safeEqual(cookie, demo))
    {
        return { demo: true };
    }

    return null;
}

// Compare hosts only: behind Railway's proxy request.url can report http while the browser origin is https.
export function sameOrigin(request: Request): boolean
{
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');

    return !origin || new URL(origin).host === host;
}
