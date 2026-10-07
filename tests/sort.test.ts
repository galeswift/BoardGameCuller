import { describe, expect, it } from 'vitest';
import { calculate, defaults, type Preference } from '@/lib/model';
import { DEFAULT_SORT, describeSort, nextSort, sortGames } from '@/lib/sort';
import { game } from './helpers';

const ranked = (prefs: Record<string, Preference> = {}) =>
    calculate({
        games: [
            game('1', { name: 'The Crew', rating: 8, complexity: 2, minutes: 20 }),
            game('2', { name: 'Azul', rating: 7.5, complexity: null, minutes: 45 }),
            game('3', { name: 'Brass', rating: 9, complexity: 4, minutes: null }),
        ],
        preferences: prefs,
        settings: { ...defaults, target: 3 },
        savedAt: null,
    }).ranked;
const names = (games: { name: string }[]) => games.map(entry => entry.name);

describe('sortGames', () =>
{
    it('sorts by name, ignoring a leading article', () =>
    {
        expect(names(sortGames(ranked(), DEFAULT_SORT))).toEqual(['Azul', 'Brass', 'The Crew']);
        expect(names(sortGames(ranked(), { key: 'name', dir: -1 }))).toEqual(['The Crew', 'Brass', 'Azul']);
    });

    it('sorts by rating, preference, reviewed and must keep', () =>
    {
        const prefs = { '1': { thumb: 1, reviewed: true }, '2': { thumb: -1, mustKeep: true }, '3': { personalRating: 6 } };

        expect(names(sortGames(ranked(prefs), { key: 'rating', dir: -1 }))).toEqual(['The Crew', 'Azul', 'Brass']);
        expect(names(sortGames(ranked(prefs), { key: 'thumb', dir: -1 }))).toEqual(['The Crew', 'Brass', 'Azul']);
        expect(names(sortGames(ranked(prefs), { key: 'reviewed', dir: 1 }))).toEqual(['Azul', 'Brass', 'The Crew']);
        expect(names(sortGames(ranked(prefs), { key: 'keep', dir: -1 }))).toEqual(['Azul', 'Brass', 'The Crew']);
    });

    it('puts unknown box sizes, weights and play times last in either direction', () =>
    {
        const prefs = { '1': { box: 0 }, '3': { box: 3 } };

        expect(names(sortGames(ranked(prefs), { key: 'box', dir: -1 }))).toEqual(['Brass', 'The Crew', 'Azul']);
        expect(names(sortGames(ranked(prefs), { key: 'box', dir: 1 }))).toEqual(['The Crew', 'Brass', 'Azul']);
        expect(names(sortGames(ranked(), { key: 'weight', dir: 1 })).at(-1)).toBe('Azul');
        expect(names(sortGames(ranked(), { key: 'time', dir: -1 }))).toEqual(['Azul', 'The Crew', 'Brass']);
    });

    it("doesn't change the original list", () =>
    {
        const list = ranked();
        const before = names(list);

        sortGames(list, { key: 'rating', dir: -1 });
        expect(names(list)).toEqual(before);
    });
});

describe('nextSort and describeSort', () =>
{
    it('starts a new column in its natural direction and flips the same column', () =>
    {
        expect(nextSort(DEFAULT_SORT, 'rating')).toEqual({ key: 'rating', dir: -1 });
        expect(nextSort({ key: 'rating', dir: -1 }, 'rating')).toEqual({ key: 'rating', dir: 1 });
        expect(nextSort({ key: 'rating', dir: 1 }, 'name')).toEqual({ key: 'name', dir: 1 });
    });
    it('describes the order in words', () =>
    {
        expect(describeSort({ key: 'rating', dir: -1 })).toBe('Rating, highest first');
        expect(describeSort({ key: 'box', dir: 1 })).toBe('Box size, smallest first');
    });
});
