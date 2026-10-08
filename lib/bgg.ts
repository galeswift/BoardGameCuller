import { XMLParser } from 'fast-xml-parser';
import { decodeEntities } from './text';
import { MAX_COLLECTION_GAMES, bggImageUrl, type Game } from './model';

// BGG XML API2. Since 2025 every request needs a registered application token:
// https://boardgamegeek.com/applications
// BGG_API_BASE lets browser tests point at a local fake BGG.
const apiBase = () => process.env.BGG_API_BASE || 'https://boardgamegeek.com/xmlapi2';

export const THING_BATCH = 20;

export const REQUEST_GAP_MS = 2000;

export class BggError extends Error
{}

// Repeating elements always parse as arrays, even when there's only one. Forum
// lists are matched by path, since <forum> and <thread> are also root elements.
const LISTS = ['item', 'link', 'name', 'result', 'poll-summary', 'error', 'listing', 'comment', 'rank'];
const LIST_PATHS = ['forums.forum', 'forum.threads.thread', 'thread.articles.article'];
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    isArray: (name, path, _leaf, isAttribute) => !isAttribute && (LISTS.includes(name) || LIST_PATHS.includes(String(path))),
});

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const num = (value: unknown) =>
{
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const text = (value: unknown): string =>
    typeof value === 'object' && value !== null ? String((value as Record<string, unknown>)['#text'] ?? '') : String(value ?? '');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;

export async function bggXml(path: string): Promise<Node>
{
    const token = process.env.BGG_API_TOKEN;

    if (!token)
    {
        throw new BggError('BGG import is not configured. Set BGG_API_TOKEN on the server.');
    }

    for (let attempt = 0; attempt < 10; attempt++)
    {
        const response = await fetch(`${apiBase()}/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });

        // 202 means BGG queued the collection export; 429/5xx are rate limits or hiccups. Both clear on retry.
        if (response.status === 202 || response.status === 429 || response.status >= 500)
        {
            await sleep(response.status === 202 ? 3000 : 5000);
            continue;
        }

        if (response.status === 401 || response.status === 403)
        {
            throw new BggError('BoardGameGeek rejected the API token.');
        }

        if (!response.ok)
        {
            throw new BggError(`BoardGameGeek returned an error (${response.status}).`);
        }

        const doc = parser.parse(await response.text());
        const message = doc.errors?.error?.[0]?.message ?? doc.items?.error?.[0]?.message;

        if (message)
        {
            throw new BggError(
                /invalid username/i.test(text(message))
                    ? 'BoardGameGeek doesn’t recognise that username.'
                    : `BoardGameGeek: ${text(message)}`
            );
        }

        return doc;
    }

    throw new BggError('BoardGameGeek is still preparing this collection. Try again in a minute.');
}

function bestPlayers(item: Node): string | undefined
{
    const summary = (item['poll-summary'] || []).find((poll: Node) => poll.name === 'suggested_numplayers');
    const best = (summary?.result || []).find((result: Node) => result.name === 'bestwith')?.value as string | undefined;

    if (!best)
    {
        return undefined;
    }

    const counts = new Set<number>();

    for (const part of best
        .replace(/^Best with/i, '')
        .replace(/players?/i, '')
        .split(','))
    {
        const [from, to] = part.split(/[–-]/).map(digits => parseInt(digits, 10));

        if (Number.isInteger(from))
        {
            for (let count = from; count <= (Number.isInteger(to) ? to : from) && count <= 100; count++)
            {
                counts.add(count);
            }
        }
    }

    return counts.size ? [...counts].join(',') : undefined;
}

const NON_THEME = new Set([
    'Card Game',
    'Dice',
    'Party Game',
    'Expansion for Base-game',
    'Educational',
    'Print & Play',
    'Collectible Components',
    'Bluffing',
    'Deduction',
    'Memory',
    'Word Game',
    'Trivia',
    'Puzzle',
    'Real-time',
    'Math',
    'Number',
    "Children's Game",
    'Action / Dexterity',
    'Negotiation',
    'Territory Building',
    'Miniatures',
    'Book',
    'Video Game Theme',
    'Movies / TV / Radio theme',
    'Comic Book / Strip',
]);

// BGG families that describe how a game was sold or catalogued rather than how it plays.
const NON_GAMEPLAY_FAMILY =
    /^(Admin|Authors|Containers|Contests|Crowdfunding|Decades|Digital Implementations|Misc|Organizations|Versions & Editions):/;

function details(item: Node)
{
    const links: Node[] = item.link || [];
    const values = (type: string) => links.filter(link => link.type === type).map(link => String(link.value));
    const mechanics = values('boardgamemechanic');
    const maxPlayers = num(item.maxplayers?.value);

    return {
        complexity: num(item.statistics?.ratings?.averageweight?.value),
        minutes: num(item.playingtime?.value),
        minPlayers: num(item.minplayers?.value),
        maxPlayers,
        bestPlayers: bestPlayers(item),
        mode: mechanics.includes('Cooperative Game')
            ? 'Cooperative'
            : mechanics.includes('Team-Based Game')
                ? 'Teams'
                : maxPlayers === 1
                    ? 'Solo'
                    : 'Competitive',
        theme: values('boardgamecategory').find(category => !NON_THEME.has(category)) || '',
        publisher: values('boardgamepublisher').find(name => name !== '(Unknown)') || '',
        parents: links
            .filter(link => link.type === 'boardgameexpansion' && link.inbound === 'true')
            .map(link => ({ id: String(link.id), name: String(link.value) })),
        categories: values('boardgamecategory'),
        mechanics,
        families: values('boardgamefamily').filter(family => !NON_GAMEPLAY_FAMILY.test(family)),
        thumbnail: bggImageUrl(text(item.thumbnail).trim()) ?? undefined,
    };
}

export type ThingDetails = ReturnType<typeof details>;

/** BGG game details (categories, mechanics, weight…) for any games, 20 per request. */
export async function fetchThingDetails(ids: string[]): Promise<Map<string, ThingDetails>>
{
    const out = new Map<string, ThingDetails>();

    for (let index = 0; index < ids.length; index += THING_BATCH)
    {
        if (index)
        {
            await sleep(REQUEST_GAP_MS);
        }

        const doc = await bggXml(`thing?id=${ids.slice(index, index + THING_BATCH).join(',')}&stats=1`);

        for (const item of doc.items?.item || [])
        {
            out.set(String(item.id), details(item));
        }
    }

    return out;
}

/** Owned games for a BGG user, keeping hand-edited fields from `previous` by BGG ID. */
export async function fetchBggCollection(username: string, previous: Game[]): Promise<Game[]>
{
    const user = encodeURIComponent(username);
    const standalone = await bggXml(`collection?username=${user}&own=1&stats=1&excludesubtype=boardgameexpansion`);

    await sleep(REQUEST_GAP_MS);
    const expansions = await bggXml(`collection?username=${user}&own=1&stats=1&subtype=boardgameexpansion`);
    const owned = new Map<string, { name: string; type: Game['type']; stats: Node }>();

    for (const [doc, type] of [
        [standalone, 'standalone'],
        [expansions, 'expansion'],
    ] as const)
    {
        for (const item of doc.items?.item || [])
        {
            if (!owned.has(String(item.objectid)))
            {
                owned.set(String(item.objectid), { name: decodeEntities(text(item.name?.[0])), type, stats: item.stats });
            }
        }
    }

    if (!owned.size)
    {
        throw new BggError(`No owned games found in ${username}’s BGG collection.`);
    }

    if (owned.size > MAX_COLLECTION_GAMES)
    {
        throw new BggError(`Collections over ${MAX_COLLECTION_GAMES.toLocaleString('en-US')} games aren’t supported.`);
    }

    const ids = [...owned.keys()];
    const things = new Map<string, ReturnType<typeof details>>();

    for (let index = 0; index < ids.length; index += THING_BATCH)
    {
        await sleep(REQUEST_GAP_MS);
        const doc = await bggXml(`thing?id=${ids.slice(index, index + THING_BATCH).join(',')}&stats=1`);

        for (const item of doc.items?.item || [])
        {
            things.set(String(item.id), details(item));
        }
    }

    const old = new Map(previous.map(game => [game.id, game]));

    return ids.map(id =>
    {
        const { name, type, stats } = owned.get(id)!;
        const thing = things.get(id);
        const prior = old.get(id);
        const parent = type === 'expansion' ? thing?.parents.find(game => owned.has(game.id)) || thing?.parents[0] : undefined;

        return {
            id,
            name,
            type,
            rating: num(stats?.rating?.average?.value),
            personalRating: num(stats?.rating?.value),
            complexity: thing?.complexity ?? null,
            minutes: prior?.minutes ?? thing?.minutes ?? num(stats?.playingtime),
            minPlayers: thing?.minPlayers ?? num(stats?.minplayers),
            maxPlayers: thing?.maxPlayers ?? num(stats?.maxplayers),
            bestPlayers: thing?.bestPlayers,
            mean: prior?.mean ?? null,
            group: prior?.group || '',
            theme: prior?.theme || thing?.theme || '',
            mode: prior?.mode || thing?.mode || '',
            notes: prior?.notes || '',
            parentId: parent?.id || prior?.parentId || '',
            parentName: parent?.name || prior?.parentName || '',
            publisher: thing?.publisher || prior?.publisher || '',
            categories: thing?.categories ?? prior?.categories,
            mechanics: thing?.mechanics ?? prior?.mechanics,
            families: thing?.families ?? prior?.families,
            thumbnail: thing?.thumbnail ?? prior?.thumbnail,
        };
    });
}
