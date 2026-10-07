import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '@/db';
import type { Game } from '@/lib/model';

/** In-process Postgres exposing the subset of pg.Pool the routes use. */
export async function createTestDb()
{
    const pg = new PGlite();

    await pg.exec(SCHEMA);
    const query = (sql: string, params?: unknown[]) => pg.query(sql, params);
    const pool = { query, connect: async () => ({ query, release()
    {} }) };

    return { pg, pool };
}

export const ORIGIN = 'http://cull.test';

export function apiRequest(path: string, init: { method?: string; body?: unknown; origin?: string } = {})
{
    const headers: Record<string, string> = { host: 'cull.test' };

    if (init.origin !== undefined)
    {
        headers.origin = init.origin;
    }
    else if (init.method === 'POST')
    {
        headers.origin = ORIGIN;
    }

    if (init.body !== undefined)
    {
        headers['content-type'] = 'application/json';
    }

    return new Request(ORIGIN + path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
}

export function game(id: string, extra: Partial<Game> = {}): Game
{
    return {
        id,
        name: `Game ${id}`,
        type: 'standalone',
        rating: 7,
        personalRating: null,
        complexity: 2,
        minutes: 60,
        minPlayers: 2,
        maxPlayers: 4,
        mean: null,
        group: '',
        theme: '',
        mode: '',
        notes: '',
        ...extra,
    };
}
