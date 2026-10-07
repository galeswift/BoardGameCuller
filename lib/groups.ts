import type { ThingDetails } from './bgg';
import type { Game } from './model';
import { openaiJson } from './openai';

// Assigns play-experience groups to games that don't have one, so imported
// collections get the same overlap scoring as hand-classified ones.
//
// Games only count as similar when their group labels match exactly, so each
// batch is shown the groups already in use (with sizes and example games) and
// asked to reuse them.

export const GROUP_BATCH = 60;
const GROUP_MAX_LENGTH = 60;

const SYSTEM = `You sort a board game collection into play-experience groups. The groups are used to spot games that fill the same slot on someone's shelf, so games in a group should be reasonable substitutes for each other.
A group is a short label of 2 to 5 words naming the kind of experience, like "Tile drafting landscapes", "Competitive trick taking", "Cooperative crisis puzzles", "Compact area conflict", "Heavy economic engine builders" or "Party word guessing".
Reuse an existing group, spelled exactly the same, whenever a game fits it. Only create a new group when nothing fits.
Group by the kind of experience: core mechanisms, mode (cooperative, competitive, solo) and feel. The app already compares weight and play time within a group, so don't split groups by weight or length, and large groups are fine when the games really play alike.
Prefer the closest existing group over creating a group for a single game. A one-game group is only right for a truly unusual game.
Never create near-duplicate names for the same idea, like "Cooperative campaign adventures" and "Narrative campaign cooperative adventures". Pick one and reuse it.
Every game listed under "Games to group" must get a group.
Reply with a JSON object: {"groups": {"<game id>": "<group>"}}.`;

export type GroupInput = { game: Game; details?: ThingDetails };

/** Groups already in use, largest first, with their size and a few example games. */
export function vocabulary(games: Game[]): string[]
{
    const byGroup = new Map<string, string[]>();
    for (const game of games)
    {
        if (game.type === 'standalone' && game.group)
        {
            byGroup.set(game.group, [...(byGroup.get(game.group) ?? []), game.name]);
        }
    }
    return [...byGroup]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([group, names]) => `- ${group} (${names.length} games, e.g. ${names.slice(0, 3).join('; ')})`);
}

/** One line per game: id | name | weight | time | players | mode | categories | mechanics. */
function describeGame({ game, details }: GroupInput): string
{
    const players = game.minPlayers && game.maxPlayers ? `${game.minPlayers}-${game.maxPlayers}p` : '';
    return [
        game.id,
        game.name,
        game.complexity ? `weight ${game.complexity.toFixed(1)}` : '',
        game.minutes ? `${game.minutes} min` : '',
        players,
        game.mode,
        details?.categories.length ? `categories: ${details.categories.slice(0, 5).join(', ')}` : '',
        details?.mechanics.length ? `mechanics: ${details.mechanics.slice(0, 8).join(', ')}` : '',
    ]
        .filter(Boolean)
        .join(' | ');
}

export function groupPrompt(batch: GroupInput[], existing: string[]): string
{
    const known = existing.length ? `Existing groups:\n${existing.join('\n')}` : 'Existing groups: none yet.';
    return `${known}\n\nGames to group (id | name | details):\n${batch.map(describeGame).join('\n')}`;
}

/** One request: well-formed groups for the games that were asked about. */
async function requestGroups(batch: GroupInput[], existing: string[]): Promise<Record<string, string>>
{
    const reply = (await openaiJson(SYSTEM, groupPrompt(batch, existing), 8000)) as {
        groups?: Record<string, unknown>;
    };
    const asked = new Set(batch.map(input => input.game.id));
    const groups: Record<string, string> = {};

    for (const [id, group] of Object.entries(reply.groups ?? {}))
    {
        if (!asked.has(id) || typeof group !== 'string') continue;
        const clean = group.replace(/\s+/g, ' ').trim().slice(0, GROUP_MAX_LENGTH);
        if (clean) groups[id] = clean;
    }
    return groups;
}

/** Groups for a batch of games. Games the model skips get one more try, with the new groups to choose from. */
export async function assignGroups(batch: GroupInput[], existing: string[]): Promise<Record<string, string>>
{
    const groups = await requestGroups(batch, existing);
    const missed = batch.filter(input => !groups[input.game.id]);
    if (missed.length)
    {
        const newGroups = [...new Set(Object.values(groups))].map(group => `- ${group}`);
        Object.assign(groups, await requestGroups(missed, [...existing, ...newGroups]));
    }
    return groups;
}
