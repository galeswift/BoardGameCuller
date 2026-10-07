import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock('next/headers', () => ({
    cookies: async () => ({ get: () => (mocks.cookie === undefined ? undefined : { value: mocks.cookie }) }),
}));

import { demoToken, getUser, getViewer, passwordMatches, sameOrigin, sessionToken } from '@/app/auth';
import { POST as login } from '@/app/api/login/route';
import { POST as logout } from '@/app/api/logout/route';
import { POST as startDemo } from '@/app/api/demo/route';

beforeEach(() =>
{
    mocks.cookie = undefined;
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
        mocks.cookie = '';
        expect(await getUser()).toBeNull();
    });

    it('accepts the session cookie and rejects tampered ones', async () =>
    {
        mocks.cookie = sessionToken()!;
        expect(await getUser()).toEqual({ signedIn: true });
        mocks.cookie = sessionToken()!.replace(/.$/, digit => (digit === '0' ? '1' : '0'));
        expect(await getUser()).toBeNull();
    });

    it('invalidates sessions when the password changes', async () =>
    {
        mocks.cookie = sessionToken()!;
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

describe('demo sessions', () =>
{
    it('tells the owner and demo visitors apart', async () =>
    {
        expect(demoToken()).not.toBe(sessionToken());
        mocks.cookie = sessionToken()!;
        expect(await getViewer()).toEqual({ demo: false });
        mocks.cookie = demoToken()!;
        expect(await getViewer()).toEqual({ demo: true });
        mocks.cookie = 'nonsense';
        expect(await getViewer()).toBeNull();
    });

    it('never treats a demo visitor as the owner', async () =>
    {
        mocks.cookie = demoToken()!;
        expect(await getUser()).toBeNull();
    });

    it('starts a one-day demo session', async () =>
    {
        const res = await startDemo();

        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/');
        const cookie = res.headers.get('set-cookie')!;

        expect(cookie).toContain(`cc_session=${demoToken()}`);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Max-Age=86400');
    });

    it('is unavailable when APP_PASSWORD is unset', async () =>
    {
        vi.stubEnv('APP_PASSWORD', '');
        expect(demoToken()).toBeNull();
        expect((await startDemo()).headers.get('location')).toBe('/login');
    });
});
