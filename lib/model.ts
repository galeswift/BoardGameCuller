export type Game = {
    id: string;
    name: string;
    type: 'standalone' | 'expansion';
    rating: number | null;
    personalRating: number | null;
    complexity: number | null;
    minutes: number | null;
    minPlayers: number | null;
    maxPlayers: number | null;
    bestPlayers?: string;
    mean: number | null;
    group: string;
    theme: string;
    mode: string;
    notes: string;
    parentId?: string;
    parentName?: string;
    publisher?: string;
    // BGG categories, mechanisms and families, used to tell how alike two games are.
    categories?: string[];
    mechanics?: string[];
    families?: string[];
    // Small box-art image from BGG's image CDN.
    thumbnail?: string;
};

/**
 * The URL when it's a BGG image-CDN address that's safe to drop into CSS `url("…")`, else null.
 * BGG thumbnail paths contain parentheses (`filters:strip_icc()`), so those are allowed; quotes,
 * backslashes and whitespace are not.
 */
export function bggImageUrl(url: unknown): string | null
{
    return typeof url === 'string' && url.length <= 500 && /^https:\/\/cf\.geekdo-images\.com\/[\w\-./%=:,()~+]+$/.test(url) ? url : null;
}

export type Preference = {
    thumb?: number;
    mustKeep?: boolean;
    reviewed?: boolean;
    box?: number | null;
    personalRating?: number | null;
    mean?: number | null;
    group?: string;
    theme?: string;
    mode?: string;
    minutes?: number | null;
    notes?: string;
    condition?: Condition | null;
};

// Noble Knight trade-in conditions, in the order their template lists them.
export const CONDITIONS = ['New', 'Unpunched', 'Used', 'Near Mint (Books Only)'] as const;

export type Condition = (typeof CONDITIONS)[number];

export const DEFAULT_CONDITION: Condition = 'Used';

export type Settings = {
    target: number;
    ratingWeight: number;
    lowThreshold: number;
    lowPenalty: number;
    overlapWeight: number;
    meanWeight: number;
    boxWeight: number;
    thumbWeight: number;
    preserve: boolean;
};

export type State = { games: Game[]; preferences: Record<string, Preference>; settings: Settings; savedAt: string | null };

export const defaults: Settings = {
    target: 192,
    ratingWeight: 70,
    lowThreshold: 7,
    lowPenalty: 15,
    overlapWeight: 20,
    // Off by default: how much players attack each other is a taste, not a reason to cull.
    meanWeight: 0,
    boxWeight: 3,
    thumbWeight: 30,
    preserve: true,
};

export const nameKey = (name: string) => name.replace(/^(the |a |an )/i, '').toLowerCase();
// Modeling choice, not a calibrated BGG conversion: a one-point increase in
// weight doubles a difficulty proxy. Substitutes must be within 50% of one
// another in that proxy (about 0.585 BGG weight points).
const maxDifficultyRatio = 1.5;

export function complexitySimilarity(weight: number | null, otherWeight: number | null): number | null
{
    if (
        weight == null ||
        otherWeight == null ||
        !Number.isFinite(weight) ||
        !Number.isFinite(otherWeight) ||
        weight < 1 ||
        weight > 5 ||
        otherWeight < 1 ||
        otherWeight > 5
    )
    {
        return null;
    }

    const relativeDifficultyGap = Math.expm1(Math.LN2 * Math.abs(weight - otherWeight));

    if (relativeDifficultyGap > maxDifficultyRatio - 1 + 1e-12)
    {
        return null;
    }

    return Math.max(0, 1 - relativeDifficultyGap / (maxDifficultyRatio - 1));
}

// Tags this alike (rarity-weighted cosine) count as a full match. That's about the 90th
// percentile of same-group pairs in the sample collection: only sequels, editions and
// games from one series score above it.
const fullTagMatch = 0.5;

/** A game's BGG tags, or null when they haven't been fetched (collections synced before tags existed). */
export function gameTags(game: Pick<Game, 'categories' | 'mechanics' | 'families'>): string[] | null
{
    const tags = [
        ...(game.categories ?? []).map(tag => 'category:' + tag),
        ...(game.mechanics ?? []).map(tag => 'mechanic:' + tag),
        ...(game.families ?? []).map(tag => 'family:' + tag),
    ];

    return tags.length ? tags : null;
}

/** How rare each tag is in the collection. Tags most games share (Fantasy, Dice Rolling) say little about a pair. */
export function tagRarity(tagLists: string[][]): Map<string, number>
{
    const counts = new Map<string, number>();

    for (const tags of tagLists)
    {
        for (const tag of new Set(tags))
        {
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
    }

    const rarity = new Map<string, number>();

    for (const [tag, count] of counts)
    {
        rarity.set(tag, Math.log((tagLists.length + 1) / (count + 1)) + 1);
    }

    return rarity;
}

/**
 * How alike two games' tags are: the cosine of their tag vectors, each tag weighted by its
 * rarity, scaled so `fullTagMatch` reads as 1. Also returns the shared tags, rarest first.
 */
export function tagSimilarity(tags: string[], otherTags: string[], rarity: Map<string, number>)
{
    const tagSet = new Set(tags);
    const otherSet = new Set(otherTags);
    const weightOf = (tag: string) => (rarity.get(tag) ?? 1) ** 2;
    const shared = [...tagSet].filter(tag => otherSet.has(tag));
    let sharedWeight = 0;
    let weight = 0;
    let otherWeight = 0;

    for (const tag of shared)
    {
        sharedWeight += weightOf(tag);
    }

    for (const tag of tagSet)
    {
        weight += weightOf(tag);
    }

    for (const tag of otherSet)
    {
        otherWeight += weightOf(tag);
    }

    const cosine = sharedWeight / Math.sqrt(weight * otherWeight);

    return {
        score: Math.min(1, cosine / fullTagMatch),
        shared: shared.sort((a, b) => weightOf(b) - weightOf(a)).map(tag => tag.slice(tag.indexOf(':') + 1)),
    };
}

export function calculate(state: State)
{
    const settings = state.settings;
    const scored = state.games
        .filter(game => game.type === 'standalone')
        .map(game =>
        {
            const preference = state.preferences[game.id] || {};
            const merged = { ...game, ...preference };
            const rating = (preference.personalRating === undefined ? game.personalRating : preference.personalRating) ?? game.rating ?? 5;
            const ratingPoints = Math.max(0, Math.min(1, (rating - 5) / 4)) * settings.ratingWeight;
            const lowRatingPenalty = Math.max(0, settings.lowThreshold - rating) * settings.lowPenalty;
            const meanPenalty = merged.mean == null ? 0 : (merged.mean / 5) * settings.meanWeight;
            const boxPenalty = preference.box == null ? 0 : (preference.box / 3) * settings.boxWeight;
            const bias = (preference.thumb || 0) * settings.thumbWeight;

            return {
                ...merged,
                preference,
                rating,
                ratingPoints,
                lowRatingPenalty,
                meanPenalty,
                boxPenalty,
                bias,
                priority: ratingPoints - lowRatingPenalty - meanPenalty - boxPenalty + bias + (preference.mustKeep ? 1000 : 0),
                overlap: 0,
                similarity: 0,
                alternative: '',
                match: null as Match | null,
            };
        });

    // Games only overlap within the same play group and mode.
    const groups = new Map<string, typeof scored>();

    for (const game of scored)
    {
        if (!game.group)
        {
            continue;
        }

        const groupKey = game.group + '|' + game.mode;
        const members = groups.get(groupKey) || [];

        members.push(game);
        groups.set(groupKey, members);
    }

    const representatives = new Set<string>();
    const tagsById = new Map<string, string[]>();

    for (const game of scored)
    {
        const tags = gameTags(game);

        if (tags)
        {
            tagsById.set(game.id, tags);
        }
    }

    const rarity = tagRarity([...tagsById.values()]);

    for (const members of groups.values())
    {
        if (members.length < 2)
        {
            continue;
        }

        const remaining = [...members].sort((a, b) => b.priority - a.priority || Number(b.id) - Number(a.id));

        while (remaining.length)
        {
            const representative = remaining.shift()!;
            // Compare each peer directly with its representative. Do not allow a chain
            // of intermediate weights to join light and heavy games into one cluster.
            const peers = remaining.filter(peer => complexitySimilarity(peer.complexity, representative.complexity) != null);

            if (!peers.length)
            {
                continue;
            }

            if (settings.preserve && (representative.preference.thumb || 0) !== -1)
            {
                representatives.add(representative.id);
            }

            for (const peer of peers)
            {
                remaining.splice(remaining.indexOf(peer), 1);
                const duration =
                    peer.minutes && representative.minutes
                        ? Math.min(peer.minutes, representative.minutes) / Math.max(peer.minutes, representative.minutes)
                        : 0;
                const weight = complexitySimilarity(peer.complexity, representative.complexity)!;
                const players =
                    peer.minPlayers && peer.maxPlayers && representative.minPlayers && representative.maxPlayers
                        ? Math.max(
                            0,
                            Math.min(peer.maxPlayers, representative.maxPlayers) -
                                  Math.max(peer.minPlayers, representative.minPlayers) +
                                  1
                        ) /
                          (Math.max(peer.maxPlayers, representative.maxPlayers) - Math.min(peer.minPlayers, representative.minPlayers) + 1)
                        : 0;
                const sameTheme = !!peer.theme && peer.theme === representative.theme;
                const peerTags = tagsById.get(peer.id);
                const representativeTags = tagsById.get(representative.id);
                const tagMatch = peerTags && representativeTags ? tagSimilarity(peerTags, representativeTags, rarity) : null;

                // Sharing a play group is a start; BGG tags decide how much of the experience overlaps.
                // Without tags (collections not yet re-synced), fall back to the single theme.
                peer.similarity = tagMatch
                    ? 0.1 + 0.6 * tagMatch.score + 0.1 * duration + 0.1 * weight + 0.1 * players
                    : Math.min(1, 0.4 + (sameTheme ? 0.15 : 0) + 0.2 * duration + 0.15 * weight + 0.1 * players);
                peer.match = {
                    sameTheme,
                    duration,
                    weight,
                    players,
                    tags: tagMatch?.score ?? null,
                    sharedTags: tagMatch?.shared ?? [],
                };
                peer.overlap = settings.overlapWeight * Math.max(0, (peer.similarity - 0.55) / 0.45);
                peer.alternative = representative.id;
            }
        }
    }

    const ranked = scored
        .map(game => ({
            ...game,
            protected: !!game.preference.mustKeep || representatives.has(game.id),
            representative: representatives.has(game.id),
            score: game.ratingPoints - game.lowRatingPenalty - game.meanPenalty - game.boxPenalty + game.bias - game.overlap,
        }))
        .sort((a, b) => Number(b.protected) - Number(a.protected) || b.score - a.score || Number(a.id) - Number(b.id));
    const protectedCount = ranked.filter(game => game.protected).length;
    const keepCount = Math.min(ranked.length, Math.max(settings.target, protectedCount));
    const kept = new Set(ranked.slice(0, keepCount).map(game => game.id));
    const cull = ranked.slice(keepCount).reverse();

    return { ranked, cull, kept, keepCount, protectedCount };
}

type Match = { sameTheme: boolean; duration: number; weight: number; players: number; tags: number | null; sharedTags: string[] };

export type Scored = ReturnType<typeof calculate>['ranked'][number];

export type FactorKind =
    'mustKeep' | 'representative' | 'thumbUp' | 'thumbDown' | 'rating' | 'lowRating' | 'overlap' | 'mean' | 'box' | 'cutoff';

/** One reason behind a game's keep score. `impact` is signed keep-score points (negative pushes toward the cull list). */
export type Factor = { kind: FactorKind; impact: number; badge: string; title: string; lines: string[]; alternativeId?: string };
const signedPoints = (points: number) => `${points < 0 ? '−' : '+'}${Math.abs(points).toFixed(1)}`;
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const playerRange = (game: Game) =>
    game.minPlayers && game.maxPlayers
        ? game.minPlayers === game.maxPlayers
            ? `${game.minPlayers}`
            : `${game.minPlayers}–${game.maxPlayers}`
        : '?';

/** Every factor behind a game's keep score, protections first, then by size of effect. */
export function keepFactors(game: Scored, state: State, result: ReturnType<typeof calculate>): Factor[]
{
    const settings = state.settings;
    const factors: Factor[] = [];

    if (game.preference.mustKeep)
    {
        factors.push({ kind: 'mustKeep', impact: 0, badge: '', title: 'Must keep', lines: ['You marked this game to always keep.'] });
    }

    if (game.representative)
    {
        factors.push({
            kind: 'representative',
            impact: 0,
            badge: '',
            title: 'Group representative',
            lines: [
                `Highest-scoring game among similar ${game.group} (${game.mode || 'any mode'}) games.`,
                'Protected so this kind of game stays on your shelf.',
            ],
        });
    }

    if (game.bias > 0)
    {
        factors.push({
            kind: 'thumbUp',
            impact: game.bias,
            badge: signedPoints(game.bias),
            title: 'Your thumbs up',
            lines: [`Adds ${game.bias.toFixed(1)} keep points.`],
        });
    }

    if (game.bias < 0)
    {
        factors.push({
            kind: 'thumbDown',
            impact: game.bias,
            badge: signedPoints(game.bias),
            title: 'Your thumbs down',
            lines: [`Removes ${(-game.bias).toFixed(1)} keep points.`],
        });
    }

    const missedRatingPoints = settings.ratingWeight - game.ratingPoints;

    if (missedRatingPoints >= 0.5)
    {
        factors.push({
            kind: 'rating',
            impact: -missedRatingPoints,
            badge: game.rating.toFixed(1),
            title: `Rating ${game.rating.toFixed(1)}/10`,
            lines: [
                game.personalRating == null
                    ? 'BGG average. Add your own rating in the game details to override it.'
                    : 'Your personal rating.',
                `Earns ${game.ratingPoints.toFixed(1)} of ${settings.ratingWeight} rating points (full points at 9/10).`,
            ],
        });
    }

    if (game.lowRatingPenalty > 0)
    {
        factors.push({
            kind: 'lowRating',
            impact: -game.lowRatingPenalty,
            badge: signedPoints(-game.lowRatingPenalty),
            title: 'Below your rating threshold',
            lines: [
                `${game.rating.toFixed(1)}/10 is ${(settings.lowThreshold - game.rating).toFixed(1)} below your ${settings.lowThreshold.toFixed(1)} threshold.`,
                `${settings.lowPenalty} points off per point below: ${signedPoints(-game.lowRatingPenalty)}.`,
            ],
        });
    }

    const alternative = result.ranked.find(other => other.id === game.alternative);

    if (game.overlap > 0 && alternative && game.match)
    {
        const match = game.match;

        factors.push({
            kind: 'overlap',
            impact: -game.overlap,
            badge: signedPoints(-game.overlap),
            title: `Similar to ${alternative.name}`,
            alternativeId: alternative.id,
            lines: [
                result.kept.has(alternative.id)
                    ? `You’re keeping ${alternative.name}, which covers the same play experience.`
                    : `${alternative.name} is also a cull candidate.`,
                `Same group: ${game.group}${game.mode ? ` · ${game.mode}` : ''}`,
                `Weight ${game.complexity?.toFixed(2)} vs ${alternative.complexity?.toFixed(2)} · ${percent(match.weight)} match`,
                match.tags != null
                    ? `BGG categories, mechanisms and families · ${percent(match.tags)} match${
                        match.sharedTags.length ? ` (both: ${match.sharedTags.slice(0, 4).join(', ')})` : ''
                    }`
                    : match.sameTheme
                        ? `Same theme: ${game.theme}`
                        : `Different theme: ${game.theme || 'unset'} vs ${alternative.theme || 'unset'}`,
                game.minutes && alternative.minutes
                    ? `Length ${game.minutes} vs ${alternative.minutes} min · ${percent(match.duration)} match`
                    : 'Length unknown for one game',
                `Players ${playerRange(game)} vs ${playerRange(alternative)} · ${percent(match.players)} overlap`,
                `Similarity ${percent(game.similarity)} (deductions start above 55%): ${signedPoints(-game.overlap)}`,
                'Click to open the similar game.',
            ],
        });
    }

    if (game.meanPenalty > 0)
    {
        factors.push({
            kind: 'mean',
            impact: -game.meanPenalty,
            badge: signedPoints(-game.meanPenalty),
            title: `Mean interaction ${game.mean}/5`,
            lines: ['Draft rating of how much players attack or block each other.', `Costs ${game.meanPenalty.toFixed(1)} keep points.`],
        });
    }

    if (game.boxPenalty > 0)
    {
        factors.push({
            kind: 'box',
            impact: -game.boxPenalty,
            badge: signedPoints(-game.boxPenalty),
            title: `${['Small', 'Standard', 'Large', 'Oversized'][game.preference.box!]} box`,
            lines: [`Shelf-space deduction: ${signedPoints(-game.boxPenalty)}.`],
        });
    }

    if (!result.kept.has(game.id) && !factors.some(factor => factor.impact < 0))
    {
        const rank = result.ranked.findIndex(other => other.id === game.id) + 1;

        factors.push({
            kind: 'cutoff',
            impact: 0,
            badge: `#${rank}`,
            title: 'Just below the keep cutoff',
            lines: [
                `Ranks #${rank} of ${result.ranked.length} by keep score (${game.score.toFixed(1)}).`,
                `You’re keeping the top ${result.keepCount} (target ${settings.target}).`,
            ],
        });
    }

    const order = (factor: Factor) => (factor.kind === 'mustKeep' ? 0 : factor.kind === 'representative' ? 1 : 2);

    return factors.sort((a, b) => order(a) - order(b) || Math.abs(b.impact) - Math.abs(a.impact));
}

/**
 * Why a game is on the cull list, in plain sentences, biggest reason first. The numbers stay
 * in the factor chips; this is the version a person reads.
 */
export function cullReasons(game: Scored, state: State, result: ReturnType<typeof calculate>): string[]
{
    const settings = state.settings;
    const ratingText =
        game.personalRating == null ? `BGG players rate it ${game.rating.toFixed(1)}` : `You rated it ${game.rating.toFixed(1)}`;
    const reasons: { impact: number; text: string }[] = [];

    if (game.lowRatingPenalty > 0)
    {
        reasons.push({ impact: -game.lowRatingPenalty, text: `${ratingText}, below your ${settings.lowThreshold.toFixed(1)} bar.` });
    }

    const alternative = result.ranked.find(other => other.id === game.alternative);

    if (game.overlap > 0 && alternative)
    {
        reasons.push({
            impact: -game.overlap,
            text: result.kept.has(alternative.id)
                ? `You’re keeping ${alternative.name}, which gives you the same kind of game (${game.group}).`
                : `It overlaps with ${alternative.name} (${game.group}), which is also on this list.`,
        });
    }

    if (game.bias < 0)
    {
        reasons.push({ impact: game.bias, text: 'You gave it a thumbs down.' });
    }

    if (game.meanPenalty > 0)
    {
        reasons.push({ impact: -game.meanPenalty, text: 'Its player-vs-player meanness counts against it.' });
    }

    if ((game.preference.box ?? 0) >= 2)
    {
        reasons.push({ impact: -game.boxPenalty, text: 'Its big box takes a lot of shelf space.' });
    }

    // The rating sentence goes first even when it isn't the biggest reason, so its "it" can't be
    // read as the similar game named in another sentence.
    const ratingFirst = (reason: { text: string }) => (reason.text.startsWith(ratingText) ? 0 : 1);

    if (reasons.length)
    {
        return reasons
            .sort((a, b) => a.impact - b.impact)
            .slice(0, 3)
            .sort((a, b) => ratingFirst(a) - ratingFirst(b))
            .map(reason => reason.text);
    }

    // Nothing specific counts against it, so the rating is what separates it from the keepers.
    const keptRatings = result.ranked
        .filter(other => result.kept.has(other.id))
        .map(other => other.rating)
        .sort((a, b) => a - b);
    const medianKept = keptRatings[Math.floor(keptRatings.length / 2)];

    if (medianKept != null && game.rating < medianKept)
    {
        return [`${ratingText}, lower than most of the games you’re keeping.`];
    }

    return [`Nothing counts against it in particular: it just ranks below the ${result.keepCount} games you’re keeping.`];
}

/** Plain-text summary of the factors, for the CSV export. */
export function cullExplanation(game: Scored, state: State, result: ReturnType<typeof calculate>)
{
    return keepFactors(game, state, result)
        .filter(factor => factor.impact < 0 || factor.kind === 'cutoff')
        .map(factor => (factor.badge ? `${factor.title} (${factor.badge})` : factor.title))
        .join('; ');
}

export function parseCSV(text: string)
{
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index++)
    {
        const char = text[index];

        if (char === '"')
        {
            if (quoted && text[index + 1] === '"')
            {
                cell += '"';
                index++;
            }
            else
            {
                quoted = !quoted;
            }
        }
        else if (char === ',' && !quoted)
        {
            row.push(cell);
            cell = '';
        }
        else if ((char === '\n' || char === '\r') && !quoted)
        {
            if (char === '\r' && text[index + 1] === '\n')
            {
                index++;
            }

            row.push(cell);
            if (row.some(Boolean))
            {
                rows.push(row);
            }

            row = [];
            cell = '';
        }
        else
        {
            cell += char;
        }
    }

    if (quoted)
    {
        throw new Error('CSV contains an unclosed quoted field.');
    }

    row.push(cell);
    if (row.some(Boolean))
    {
        rows.push(row);
    }

    const headers = rows.shift()?.map(header => header.replace(/^﻿/, '').trim().toLowerCase()) || [];

    return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

export function collectionFromCSV(text: string, previous: Game[])
{
    const rows = parseCSV(text);

    if (!rows.length || !('objectid' in rows[0]) || !('objectname' in rows[0]))
    {
        throw new Error('Upload a BGG collection CSV with objectid and objectname columns.');
    }

    const previousById = new Map(previous.map(game => [game.id, game]));
    const toNumber = (cell: string) => Number(cell) || null;
    const games: Game[] = rows
        .filter(row => row.own === '1')
        .map(row =>
        {
            const prior = previousById.get(row.objectid);

            return {
                id: row.objectid,
                name: row.objectname,
                type: row.itemtype === 'expansion' ? 'expansion' : 'standalone',
                rating: toNumber(row.average),
                personalRating: toNumber(row.rating),
                complexity: toNumber(row.avgweight),
                minutes: prior?.minutes ?? toNumber(row.maxplaytime),
                minPlayers: toNumber(row.minplayers),
                maxPlayers: toNumber(row.maxplayers),
                bestPlayers: row.bggbestplayers,
                mean: prior?.mean ?? null,
                group: prior?.group || '',
                theme: prior?.theme || '',
                mode: prior?.mode || '',
                notes: prior?.notes || '',
                parentId: prior?.parentId || '',
                parentName: prior?.parentName || '',
                publisher: prior?.publisher || '',
            };
        });

    if (!games.length)
    {
        throw new Error('No owned games found in this CSV.');
    }

    if (new Set(games.map(game => game.id)).size !== games.length)
    {
        throw new Error('Duplicate BGG IDs found. Export one entry per game.');
    }

    return games;
}
