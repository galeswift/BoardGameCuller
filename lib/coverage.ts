import type { Scored } from './model';

// Broad kinds of play experience, for showing what a collection covers before and after a cull.
// They overlap on purpose (a game can be cooperative, quick and a deduction game), and they're
// coarser than play groups so the whole list fits on one screen.
type Experience = { label: string; phrase: string; usesTags: boolean; matches: (game: Scored) => boolean };

const hasTag = (game: Scored, names: string[]) =>
    names.some(name => game.categories?.includes(name) || game.mechanics?.includes(name) || game.families?.includes(name));

const bestAtTwo = (game: Scored) => game.maxPlayers === 2 || (game.bestPlayers ?? '').split(',').includes('2');

export const EXPERIENCES: Experience[] = [
    { label: 'Heavy strategy', phrase: 'heavy strategy games', usesTags: false, matches: game => (game.complexity ?? 0) >= 3.3 },
    {
        label: 'Medium-weight strategy',
        phrase: 'medium-weight strategy games',
        usesTags: false,
        matches: game => (game.complexity ?? 0) >= 2.3 && (game.complexity ?? 0) < 3.3,
    },
    {
        label: 'Light and family games',
        phrase: 'light and family games',
        usesTags: false,
        matches: game => game.complexity != null && game.complexity < 2.3,
    },
    {
        label: 'Quick fillers (30 min or less)',
        phrase: 'quick fillers',
        usesTags: false,
        matches: game => !!game.minutes && game.minutes <= 30,
    },
    { label: 'Long epics (2+ hours)', phrase: 'long epics', usesTags: false, matches: game => !!game.minutes && game.minutes >= 120 },
    {
        label: 'Cooperative',
        phrase: 'cooperative games',
        usesTags: false,
        matches: game => game.mode === 'Cooperative' || hasTag(game, ['Cooperative Game']),
    },
    { label: 'Solo play', phrase: 'solo games', usesTags: false, matches: game => game.minPlayers === 1 },
    { label: 'Great at two', phrase: 'games that shine at two', usesTags: false, matches: bestAtTwo },
    { label: 'Big groups (6+)', phrase: 'games for big groups', usesTags: false, matches: game => (game.maxPlayers ?? 0) >= 6 },
    {
        label: 'Team play',
        phrase: 'team games',
        usesTags: false,
        matches: game => game.mode === 'Teams' || hasTag(game, ['Team-Based Game']),
    },
    { label: 'Party games', phrase: 'party games', usesTags: true, matches: game => hasTag(game, ['Party Game']) },
    {
        label: 'Deduction and bluffing',
        phrase: 'deduction and bluffing games',
        usesTags: true,
        matches: game => hasTag(game, ['Deduction', 'Bluffing', 'Hidden Roles', 'Traitor Game']),
    },
    {
        label: 'Campaigns and adventures',
        phrase: 'campaigns and adventures',
        usesTags: true,
        matches: game => hasTag(game, ['Scenario / Mission / Campaign Game', 'Legacy Game', 'Category: Dungeon Crawler']),
    },
    { label: 'Economic engines', phrase: 'economic engines', usesTags: true, matches: game => hasTag(game, ['Economic']) },
    {
        label: 'Deck and bag building',
        phrase: 'deck and bag builders',
        usesTags: true,
        matches: game => hasTag(game, ['Deck, Bag, and Pool Building']),
    },
    { label: 'Worker placement', phrase: 'worker placement games', usesTags: true, matches: game => hasTag(game, ['Worker Placement']) },
    {
        label: 'Tile laying and spatial puzzles',
        phrase: 'tile-laying and spatial puzzles',
        usesTags: true,
        matches: game => hasTag(game, ['Tile Placement', 'Pattern Building', 'Grid Coverage', 'Puzzle']),
    },
    { label: 'Roll and write', phrase: 'roll and writes', usesTags: true, matches: game => hasTag(game, ['Paper-and-Pencil']) },
    {
        label: 'Area control and conflict',
        phrase: 'area control and conflict games',
        usesTags: true,
        matches: game => hasTag(game, ['Area Majority / Influence', 'Wargame']),
    },
    { label: 'Trick-taking', phrase: 'trick-taking games', usesTags: true, matches: game => hasTag(game, ['Trick-taking']) },
    { label: 'Push your luck', phrase: 'push-your-luck games', usesTags: true, matches: game => hasTag(game, ['Push Your Luck']) },
    { label: 'Abstract strategy', phrase: 'abstract strategy games', usesTags: true, matches: game => hasTag(game, ['Abstract Strategy']) },
    { label: 'Word and trivia', phrase: 'word and trivia games', usesTags: true, matches: game => hasTag(game, ['Word Game', 'Trivia']) },
    {
        label: 'Dexterity and real-time',
        phrase: 'dexterity and real-time games',
        usesTags: true,
        matches: game => hasTag(game, ['Action / Dexterity', 'Real-Time']),
    },
];

export type ExperienceCoverage = { label: string; phrase: string; before: number; kept: number; culled: string[] };

export type Coverage = {
    experiences: ExperienceCoverage[];
    /** Share of play groups (the app's finest-grained experiences) that keep at least one game. */
    share: number;
    groupCount: number;
    lost: ExperienceCoverage[];
    /** Experiences with 3+ games that keep fewer than half of them. */
    thinned: ExperienceCoverage[];
    /** Play groups whose every game is on the cull list. */
    lostGroups: { group: string; games: string[] }[];
    /** False when no game has BGG tags yet, so tag-based experiences can't be shown. */
    tagged: boolean;
};

export function coverage(ranked: Scored[], kept: Set<string>): Coverage
{
    const tagged = ranked.some(game => game.categories?.length || game.mechanics?.length);
    const experiences = EXPERIENCES.filter(experience => tagged || !experience.usesTags)
        .map(experience =>
        {
            const members = ranked.filter(experience.matches);

            return {
                label: experience.label,
                phrase: experience.phrase,
                before: members.length,
                kept: members.filter(game => kept.has(game.id)).length,
                culled: members.filter(game => !kept.has(game.id)).map(game => game.name),
            };
        })
        .filter(experience => experience.before > 0);
    const lost = experiences.filter(experience => experience.kept === 0);
    const thinned = experiences.filter(
        experience => experience.kept > 0 && experience.before >= 3 && experience.kept < experience.before / 2
    );
    const groups = new Map<string, Scored[]>();

    for (const game of ranked)
    {
        if (!game.group)
        {
            continue;
        }

        const members = groups.get(game.group) ?? [];

        members.push(game);
        groups.set(game.group, members);
    }

    const lostGroups = [...groups]
        .filter(([, members]) => members.every(game => !kept.has(game.id)))
        .map(([group, members]) => ({ group, games: members.map(game => game.name) }))
        .sort((a, b) => a.group.localeCompare(b.group));

    return {
        experiences,
        share: groups.size ? (groups.size - lostGroups.length) / groups.size : 1,
        groupCount: groups.size,
        lost,
        thinned,
        lostGroups,
        tagged,
    };
}

const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The headline: how much play-experience coverage survives the cull, and what (if anything) goes. */
export function coverageSummary(result: Coverage, cullCount: number): string[]
{
    const gameWord = cullCount === 1 ? 'game' : 'games';
    const keptGroups = result.groupCount - result.lostGroups.length;
    const lines = [
        result.groupCount
            ? `Letting go of these ${cullCount} ${gameWord} keeps ${Math.round(result.share * 100)}% of your play experiences: ${keptGroups} of ${result.groupCount} play groups still have a game.`
            : `You’re letting go of ${cullCount} ${gameWord}.`,
    ];

    if (!result.lost.length)
    {
        lines.push('Every broad kind of game you own still has a place on your shelf.');
    }
    else if (result.lost.length === 1)
    {
        lines.push(`The only broad kind of game you’d lose: ${result.lost[0].phrase}.`);
    }
    else
    {
        lines.push(`You’d lose ${listOf(result.lost.map(experience => experience.phrase))}.`);
    }

    if (result.thinned.length)
    {
        lines.push(
            `Thinner afterwards: ${listOf(result.thinned.map(experience => `${experience.phrase} (${experience.before} → ${experience.kept})`))}.`
        );
    }

    return lines;
}
