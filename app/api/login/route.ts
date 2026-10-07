import { SESSION_COOKIE, SESSION_MAX_AGE, passwordMatches, sessionToken } from '../../auth';
export const dynamic = 'force-dynamic';

const redirect = (location: string, cookie?: string) =>
    new Response(null, { status: 303, headers: { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });

export async function POST(request: Request)
{
    const form = await request.formData();
    const input = form.get('password');
    if (typeof input !== 'string' || !passwordMatches(input))
    {
        // Slow down guessing a little; use a long APP_PASSWORD regardless.
        await new Promise(r => setTimeout(r, 750));
        return redirect('/login?error=1');
    }
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return redirect('/', `${SESSION_COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`);
}
