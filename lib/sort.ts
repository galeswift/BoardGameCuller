import { nameKey, type Scored } from './model';

// Sorting for the All Games list. Each key has the direction that's most useful
// on first click; clicking the same column again reverses it.
export type SortKey = 'reviewed' | 'name' | 'rating' | 'thumb' | 'box' | 'keep' | 'weight' | 'time';
export type Sort = { key: SortKey; dir: 1 | -1 };

export const SORTS: Record<SortKey, { label: string; dir: 1 | -1; up: string; down: string }> = {
    name: { label: 'Name', dir: 1, up: 'A to Z', down: 'Z to A' },
    reviewed: { label: 'Reviewed', dir: 1, up: 'not reviewed first', down: 'reviewed first' },
    rating: { label: 'Rating', dir: -1, up: 'lowest first', down: 'highest first' },
    thumb: { label: 'Preference', dir: -1, up: 'thumbs down first', down: 'thumbs up first' },
    box: { label: 'Box size', dir: -1, up: 'smallest first', down: 'largest first' },
    keep: { label: 'Must keep', dir: -1, up: 'others first', down: 'must keep first' },
    weight: { label: 'BGG weight', dir: 1, up: 'lightest first', down: 'heaviest first' },
    time: { label: 'Play time', dir: 1, up: 'shortest first', down: 'longest first' },
};
export const DEFAULT_SORT: Sort = { key: 'name', dir: 1 };

/** Click on a column: a new column starts in its natural direction, the same column flips. */
export const nextSort = (current: Sort, key: SortKey): Sort =>
    current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: SORTS[key].dir };
export const describeSort = (s: Sort) => `${SORTS[s.key].label}, ${s.dir === 1 ? SORTS[s.key].up : SORTS[s.key].down}`;

function value(g: Scored, key: SortKey): number | string | null
{
    switch (key)
    {
        case 'name':
            return nameKey(g.name);
        case 'reviewed':
            return g.p.reviewed ? 1 : 0;
        case 'rating':
            return g.rating;
        case 'thumb':
            return g.p.thumb ?? 0;
        case 'box':
            return g.p.box ?? null;
        case 'keep':
            return g.p.mustKeep ? 1 : 0;
        case 'weight':
            return g.complexity;
        case 'time':
            return g.minutes;
    }
}

/** Sorted copy. Unknown values (no box size, weight or time) always go last; ties fall back to name. */
export function sortGames<T extends Scored>(games: T[], { key, dir }: Sort): T[]
{
    return [...games].sort((a, b) =>
    {
        const va = value(a, key),
            vb = value(b, key);
        if (va == null || vb == null)
        {
            if (va != null) return -1;
            if (vb != null) return 1;
        }
        else if (va !== vb) return (typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)) * dir;
        return nameKey(a.name).localeCompare(nameKey(b.name));
    });
}
