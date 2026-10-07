import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
    cookies: async () => ({ get: () => (h.cookie === undefined ? undefined : { value: h.cookie }) }),
}));

import { getUser, passwordMatches, sameOrigin, sessionToken } from '@/app/auth';
import { POST as login } from '@/app/api/login/route';
import { POST as logout } from '@/app/api/logout/route';

beforeEach(() =>
{
    h.cookie = undefined;
});
afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('password gate', () =>
{
    it('matches only the configured password', () =>
    {
        expect(passwordMatches('test-password')).toBe(true);
        expect(passwordMatches('test-passwor')).toBe(false);
        expect(passwordMatches('')).toBe(false);
    });

    it('refuses everything when APP_PASSWORD is unset', async () =>
    {
        vi.stubEnv('APP_PASSWORD', '');
        expect(passwordMatches('')).toBe(false);
        expect(sessionToken()).toBeNull();
        h.cookie = '';
        expect(await getUser()).toBeNull();
    });

    it('accepts the session cookie and rejects tampered ones', async () =>
    {
        h.cookie = sessionToken()!;
        expect(await getUser()).toEqual({ signedIn: true });
        h.cookie = sessionToken()!.replace(/.$/, c => (c === '0' ? '1' : '0'));
        expect(await getUser()).toBeNull();
    });

    it('invalidates sessions when the password changes', async () =>
    {
        h.cookie = sessionToken()!;
        vi.stubEnv('APP_PASSWORD', 'rotated');
        expect(await getUser()).toBeNull();
    });
});

describe('sameOrigin', () =>
{
    const req = (headers: Record<string, string>) => new Request('http://internal:3000/api/state', { headers });
    it('allows same host, even when the proxy hides https', () =>
    {
        expect(sameOrigin(req({ origin: 'https://cull.example', host: 'cull.example' }))).toBe(true);
        expect(sameOrigin(req({ origin: 'https://cull.example', host: 'internal:3000', 'x-forwarded-host': 'cull.example' }))).toBe(true);
        expect(sameOrigin(req({ host: 'cull.example' }))).toBe(true);
    });
    it('blocks other sites', () =>
    {
        expect(sameOrigin(req({ origin: 'https://evil.example', host: 'cull.example' }))).toBe(false);
    });
});

describe('login and logout routes', () =>
{
    const form = (password: string) =>
        new Request('http://cull.test/api/login', { method: 'POST', body: new URLSearchParams({ password }) });

    it('sets an HttpOnly session cookie on the right password', async () =>
    {
        const res = await login(form('test-password'));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/');
        const cookie = res.headers.get('set-cookie')!;
        expect(cookie).toContain(`cc_session=${sessionToken()}`);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
    });

    it('redirects back with an error on the wrong password', async () =>
    {
        vi.useFakeTimers();
        const pending = login(form('guess'));
        await vi.runAllTimersAsync();
        const res = await pending;
        expect(res.headers.get('location')).toBe('/login?error=1');
        expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('clears the cookie on logout', async () =>
    {
        const res = await logout();
        expect(res.headers.get('location')).toBe('/login');
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    });
});
