import { DEMO_MAX_AGE, SESSION_COOKIE, demoToken } from '../../auth';

export const dynamic = 'force-dynamic';

// Starts a demo session: a read-only look at the sample collection, no password needed.
export async function POST()
{
    const token = demoToken();

    if (!token)
    {
        return new Response(null, { status: 303, headers: { Location: '/login' } });
    }

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    return new Response(null, {
        status: 303,
        headers: {
            Location: '/',
            'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEMO_MAX_AGE}${secure}`,
        },
    });
}
