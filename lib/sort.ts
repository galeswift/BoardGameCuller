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

export const describeSort = (sort: Sort) => `${SORTS[sort.key].label}, ${sort.dir === 1 ? SORTS[sort.key].up : SORTS[sort.key].down}`;

function value(game: Scored, key: SortKey): number | string | null
{
    switch (key)
    {
        case 'name':
            return nameKey(game.name);
        case 'reviewed':
            return game.preference.reviewed ? 1 : 0;
        case 'rating':
            return game.rating;
        case 'thumb':
            return game.preference.thumb ?? 0;
        case 'box':
            return game.preference.box ?? null;
        case 'keep':
            return game.preference.mustKeep ? 1 : 0;
        case 'weight':
            return game.complexity;
        case 'time':
            return game.minutes;
    }
}

/** Sorted copy. Unknown values (no box size, weight or time) always go last; ties fall back to name. */
export function sortGames<T extends Scored>(games: T[], { key, dir }: Sort): T[]
{
    return [...games].sort((a, b) =>
    {
        const valueA = value(a, key);
        const valueB = value(b, key);

        if (valueA == null || valueB == null)
        {
            if (valueA != null)
            {
                return -1;
            }

            if (valueB != null)
            {
                return 1;
            }
        }
        else if (valueA !== valueB)
        {
            return (typeof valueA === 'string' ? valueA.localeCompare(valueB as string) : valueA - (valueB as number)) * dir;
        }

        return nameKey(a.name).localeCompare(nameKey(b.name));
    });
}
