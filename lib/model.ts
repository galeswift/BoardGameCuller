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
};
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
    meanWeight: 10,
    boxWeight: 3,
    thumbWeight: 30,
    preserve: true,
};
export const nameKey = (name: string) => name.replace(/^(the |a |an )/i, '').toLowerCase();
// Modeling choice, not a calibrated BGG conversion: a one-point increase in
// weight doubles a difficulty proxy. Substitutes must be within 50% of one
// another in that proxy (about 0.585 BGG weight points).
const maxDifficultyRatio = 1.5;
export function complexitySimilarity(a: number | null, b: number | null): number | null
{
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a < 1 || a > 5 || b < 1 || b > 5) return null;
    const relativeDifficultyGap = Math.expm1(Math.LN2 * Math.abs(a - b));
    if (relativeDifficultyGap > maxDifficultyRatio - 1 + 1e-12) return null;
    return Math.max(0, 1 - relativeDifficultyGap / (maxDifficultyRatio - 1));
}
export function calculate(state: State)
{
    const s = state.settings;
    const list = state.games
        .filter(g => g.type === 'standalone')
        .map(g =>
        {
            const p = state.preferences[g.id] || {};
            const merged = { ...g, ...p };
            const rating = (p.personalRating === undefined ? g.personalRating : p.personalRating) ?? g.rating ?? 5;
            const ratingPoints = Math.max(0, Math.min(1, (rating - 5) / 4)) * s.ratingWeight;
            const low = Math.max(0, s.lowThreshold - rating) * s.lowPenalty;
            const mean = merged.mean == null ? 0 : (merged.mean / 5) * s.meanWeight;
            const box = p.box == null ? 0 : (p.box / 3) * s.boxWeight;
            const bias = (p.thumb || 0) * s.thumbWeight;
            return {
                ...merged,
                p,
                rating,
                ratingPoints,
                low,
                meanPenalty: mean,
                boxPenalty: box,
                bias,
                priority: ratingPoints - low - mean - box + bias + (p.mustKeep ? 1000 : 0),
                overlap: 0,
                similarity: 0,
                alternative: '',
                match: null as Match | null,
            };
        });
    const groups = new Map<string, typeof list>();
    for (const g of list)
    {
        if (!g.group) continue;
        const key = g.group + '|' + g.mode;
        const a = groups.get(key) || [];
        a.push(g);
        groups.set(key, a);
    }
    const representatives = new Set<string>();
    for (const a of groups.values())
    {
        if (a.length < 2) continue;
        const remaining = [...a].sort((a, b) => b.priority - a.priority || Number(b.id) - Number(a.id));
        while (remaining.length)
        {
            const rep = remaining.shift()!;
            // Compare each peer directly with its representative. Do not allow a chain
            // of intermediate weights to join light and heavy games into one cluster.
            const peers = remaining.filter(g => complexitySimilarity(g.complexity, rep.complexity) != null);
            if (!peers.length) continue;
            if (s.preserve && (rep.p.thumb || 0) !== -1) representatives.add(rep.id);
            for (const g of peers)
            {
                remaining.splice(remaining.indexOf(g), 1);
                const duration = g.minutes && rep.minutes ? Math.min(g.minutes, rep.minutes) / Math.max(g.minutes, rep.minutes) : 0;
                const weight = complexitySimilarity(g.complexity, rep.complexity)!;
                const players =
                    g.minPlayers && g.maxPlayers && rep.minPlayers && rep.maxPlayers
                        ? Math.max(0, Math.min(g.maxPlayers, rep.maxPlayers) - Math.max(g.minPlayers, rep.minPlayers) + 1) /
                          (Math.max(g.maxPlayers, rep.maxPlayers) - Math.min(g.minPlayers, rep.minPlayers) + 1)
                        : 0;
                const sameTheme = !!g.theme && g.theme === rep.theme;
                g.similarity = Math.min(1, 0.4 + (sameTheme ? 0.15 : 0) + 0.2 * duration + 0.15 * weight + 0.1 * players);
                g.match = { sameTheme, duration, weight, players };
                g.overlap = s.overlapWeight * Math.max(0, (g.similarity - 0.55) / 0.45);
                g.alternative = rep.id;
            }
        }
    }
    const ranked = list
        .map(g => ({
            ...g,
            protected: !!g.p.mustKeep || representatives.has(g.id),
            representative: representatives.has(g.id),
            score: g.ratingPoints - g.low - g.meanPenalty - g.boxPenalty + g.bias - g.overlap,
        }))
        .sort((a, b) => Number(b.protected) - Number(a.protected) || b.score - a.score || Number(a.id) - Number(b.id));
    const protectedCount = ranked.filter(g => g.protected).length;
    const keepCount = Math.min(ranked.length, Math.max(s.target, protectedCount));
    const kept = new Set(ranked.slice(0, keepCount).map(g => g.id));
    const cull = ranked.slice(keepCount).reverse();
    return { ranked, cull, kept, keepCount, protectedCount };
}
type Match = { sameTheme: boolean; duration: number; weight: number; players: number };
export type Scored = ReturnType<typeof calculate>['ranked'][number];
export type FactorKind =
    'mustKeep' | 'representative' | 'thumbUp' | 'thumbDown' | 'rating' | 'lowRating' | 'overlap' | 'mean' | 'box' | 'cutoff';
/** One reason behind a game's keep score. `impact` is signed keep-score points (negative pushes toward the cull list). */
export type Factor = { kind: FactorKind; impact: number; badge: string; title: string; lines: string[]; alternativeId?: string };
const pts = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const players = (g: Game) =>
    g.minPlayers && g.maxPlayers ? (g.minPlayers === g.maxPlayers ? `${g.minPlayers}` : `${g.minPlayers}–${g.maxPlayers}`) : '?';
/** Every factor behind a game's keep score, protections first, then by size of effect. */
export function keepFactors(g: Scored, state: State, result: ReturnType<typeof calculate>): Factor[]
{
    const s = state.settings,
        out: Factor[] = [];
    if (g.p.mustKeep)
        out.push({ kind: 'mustKeep', impact: 0, badge: '', title: 'Must keep', lines: ['You marked this game to always keep.'] });
    if (g.representative)
        out.push({
            kind: 'representative',
            impact: 0,
            badge: '',
            title: 'Group representative',
            lines: [
                `Highest-scoring game among similar ${g.group} (${g.mode || 'any mode'}) games.`,
                'Protected so this kind of game stays on your shelf.',
            ],
        });
    if (g.bias > 0)
        out.push({
            kind: 'thumbUp',
            impact: g.bias,
            badge: pts(g.bias),
            title: 'Your thumbs up',
            lines: [`Adds ${g.bias.toFixed(1)} keep points.`],
        });
    if (g.bias < 0)
        out.push({
            kind: 'thumbDown',
            impact: g.bias,
            badge: pts(g.bias),
            title: 'Your thumbs down',
            lines: [`Removes ${(-g.bias).toFixed(1)} keep points.`],
        });
    const missed = s.ratingWeight - g.ratingPoints;
    if (missed >= 0.5)
        out.push({
            kind: 'rating',
            impact: -missed,
            badge: g.rating.toFixed(1),
            title: `Rating ${g.rating.toFixed(1)}/10`,
            lines: [
                g.personalRating == null ? 'BGG average. Add your own rating in the game details to override it.' : 'Your personal rating.',
                `Earns ${g.ratingPoints.toFixed(1)} of ${s.ratingWeight} rating points (full points at 9/10).`,
            ],
        });
    if (g.low > 0)
        out.push({
            kind: 'lowRating',
            impact: -g.low,
            badge: pts(-g.low),
            title: 'Below your rating threshold',
            lines: [
                `${g.rating.toFixed(1)}/10 is ${(s.lowThreshold - g.rating).toFixed(1)} below your ${s.lowThreshold.toFixed(1)} threshold.`,
                `${s.lowPenalty} points off per point below: ${pts(-g.low)}.`,
            ],
        });
    const alt = result.ranked.find(o => o.id === g.alternative);
    if (g.overlap > 0 && alt && g.match)
    {
        const m = g.match;
        out.push({
            kind: 'overlap',
            impact: -g.overlap,
            badge: pts(-g.overlap),
            title: `Similar to ${alt.name}`,
            alternativeId: alt.id,
            lines: [
                result.kept.has(alt.id)
                    ? `You’re keeping ${alt.name}, which covers the same play experience.`
                    : `${alt.name} is also a cull candidate.`,
                `Same group: ${g.group}${g.mode ? ` · ${g.mode}` : ''}`,
                `Weight ${g.complexity?.toFixed(2)} vs ${alt.complexity?.toFixed(2)} · ${pct(m.weight)} match`,
                m.sameTheme ? `Same theme: ${g.theme}` : `Different theme: ${g.theme || 'unset'} vs ${alt.theme || 'unset'}`,
                g.minutes && alt.minutes
                    ? `Length ${g.minutes} vs ${alt.minutes} min · ${pct(m.duration)} match`
                    : 'Length unknown for one game',
                `Players ${players(g)} vs ${players(alt)} · ${pct(m.players)} overlap`,
                `Similarity ${pct(g.similarity)} (deductions start above 55%): ${pts(-g.overlap)}`,
                'Click to open the similar game.',
            ],
        });
    }
    if (g.meanPenalty > 0)
        out.push({
            kind: 'mean',
            impact: -g.meanPenalty,
            badge: pts(-g.meanPenalty),
            title: `Mean interaction ${g.mean}/5`,
            lines: ['Draft rating of how much players attack or block each other.', `Costs ${g.meanPenalty.toFixed(1)} keep points.`],
        });
    if (g.boxPenalty > 0)
        out.push({
            kind: 'box',
            impact: -g.boxPenalty,
            badge: pts(-g.boxPenalty),
            title: `${['Small', 'Standard', 'Large', 'Oversized'][g.p.box!]} box`,
            lines: [`Shelf-space deduction: ${pts(-g.boxPenalty)}.`],
        });
    if (!result.kept.has(g.id) && !out.some(f => f.impact < 0))
    {
        const rank = result.ranked.findIndex(o => o.id === g.id) + 1;
        out.push({
            kind: 'cutoff',
            impact: 0,
            badge: `#${rank}`,
            title: 'Just below the keep cutoff',
            lines: [
                `Ranks #${rank} of ${result.ranked.length} by keep score (${g.score.toFixed(1)}).`,
                `You’re keeping the top ${result.keepCount} (target ${s.target}).`,
            ],
        });
    }
    const order = (f: Factor) => (f.kind === 'mustKeep' ? 0 : f.kind === 'representative' ? 1 : 2);
    return out.sort((a, b) => order(a) - order(b) || Math.abs(b.impact) - Math.abs(a.impact));
}
/** Plain-text summary of the factors, for the CSV export. */
export function cullExplanation(g: Scored, state: State, result: ReturnType<typeof calculate>)
{
    return keepFactors(g, state, result)
        .filter(f => f.impact < 0 || f.kind === 'cutoff')
        .map(f => (f.badge ? `${f.title} (${f.badge})` : f.title))
        .join('; ');
}
export function parseCSV(text: string)
{
    const rows: string[][] = [];
    let row: string[] = [],
        cell = '',
        quoted = false;
    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if (c === '"')
        {
            if (quoted && text[i + 1] === '"')
            {
                cell += '"';
                i++;
            }
            else quoted = !quoted;
        }
        else if (c === ',' && !quoted)
        {
            row.push(cell);
            cell = '';
        }
        else if ((c === '\n' || c === '\r') && !quoted)
        {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            if (row.some(Boolean)) rows.push(row);
            row = [];
            cell = '';
        }
        else cell += c;
    }
    if (quoted) throw new Error('CSV contains an unclosed quoted field.');
    row.push(cell);
    if (row.some(Boolean)) rows.push(row);
    const headers =
        rows.shift()?.map(x =>
            x
                .replace(/^\uFEFF/, '')
                .trim()
                .toLowerCase()
        ) || [];
    return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}
export function collectionFromCSV(text: string, previous: Game[])
{
    const rows = parseCSV(text);
    if (!rows.length || !('objectid' in rows[0]) || !('objectname' in rows[0]))
        throw new Error('Upload a BGG collection CSV with objectid and objectname columns.');
    const old = new Map(previous.map(g => [g.id, g]));
    const num = (v: string) => Number(v) || null;
    const games: Game[] = rows
        .filter(r => r.own === '1')
        .map(r =>
        {
            const prior = old.get(r.objectid);
            return {
                id: r.objectid,
                name: r.objectname,
                type: r.itemtype === 'expansion' ? 'expansion' : 'standalone',
                rating: num(r.average),
                personalRating: num(r.rating),
                complexity: num(r.avgweight),
                minutes: prior?.minutes ?? num(r.maxplaytime),
                minPlayers: num(r.minplayers),
                maxPlayers: num(r.maxplayers),
                bestPlayers: r.bggbestplayers,
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
    if (!games.length) throw new Error('No owned games found in this CSV.');
    if (new Set(games.map(g => g.id)).size !== games.length) throw new Error('Duplicate BGG IDs found. Export one entry per game.');
    return games;
}
