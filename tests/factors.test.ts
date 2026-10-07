import { describe, expect, it } from 'vitest';
import { calculate, cullExplanation, defaults, keepFactors, type Preference, type State } from '@/lib/model';
import { game } from './helpers';

const peer = (id: string, rating: number, extra = {}) =>
    game(id, {
        name: `Peer ${id}`,
        rating,
        complexity: 2.5,
        minutes: 60,
        minPlayers: 2,
        maxPlayers: 4,
        group: 'Engine builders',
        theme: 'Nature',
        mode: 'Competitive',
        ...extra,
    });

function setup(games: ReturnType<typeof game>[], preferences: Record<string, Preference> = {}, settings = {})
{
    const state: State = { games, preferences, settings: { ...defaults, target: 1, ...settings }, savedAt: null };
    const result = calculate(state);
    const factors = (id: string) =>
        keepFactors(
            result.ranked.find(g => g.id === id)!,
            state,
            result
        );
    return { state, result, factors };
}

describe('keepFactors', () =>
{
    it('explains overlap with the kept alternative in detail', () =>
    {
        const { factors } = setup([peer('1', 8.5), peer('2', 7.5, { minutes: 75 })]);
        const overlap = factors('2').find(f => f.kind === 'overlap')!;
        expect(overlap.title).toBe('Similar to Peer 1');
        expect(overlap.alternativeId).toBe('1');
        expect(overlap.impact).toBeLessThan(0);
        expect(overlap.lines).toEqual(
            expect.arrayContaining([
                'You’re keeping Peer 1, which covers the same play experience.',
                'Same group: Engine builders · Competitive',
                'Weight 2.50 vs 2.50 · 100% match',
                'Same theme: Nature',
                'Length 75 vs 60 min · 80% match',
                'Players 2–4 vs 2–4 · 100% overlap',
            ])
        );
    });

    it('marks the group representative and ranks factors by impact', () =>
    {
        const { factors } = setup([peer('1', 8.5), peer('2', 6.0)], { '2': { thumb: -1, box: 3 } });
        expect(factors('1')[0]).toMatchObject({ kind: 'representative' });
        const kinds = factors('2').map(f => f.kind);
        expect(kinds).toEqual(['rating', 'thumbDown', 'overlap', 'lowRating', 'box']);
        const impacts = factors('2').map(f => Math.abs(f.impact));
        expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    });

    it('describes rating, threshold, mean and box penalties with short badges', () =>
    {
        const { factors } = setup([game('1', { rating: 9 }), game('2', { rating: 6, mean: 3 })], { '2': { box: 2 } });
        const byKind = Object.fromEntries(factors('2').map(f => [f.kind, f]));
        expect(byKind.rating).toMatchObject({ badge: '6.0', title: 'Rating 6.0/10' });
        expect(byKind.rating.lines[0]).toContain('BGG average');
        expect(byKind.lowRating).toMatchObject({ badge: '−15.0', impact: -15 });
        expect(byKind.mean).toMatchObject({ title: 'Mean interaction 3/5', badge: '−6.0' });
        expect(byKind.box).toMatchObject({ title: 'Large box', badge: '−2.0' });
    });

    it('uses your own rating when set, and shows thumbs up as a positive', () =>
    {
        const { factors } = setup([game('1', { rating: 6 })], { '1': { personalRating: 8, thumb: 1 } });
        const byKind = Object.fromEntries(factors('1').map(f => [f.kind, f]));
        expect(byKind.rating.lines[0]).toBe('Your personal rating.');
        expect(byKind.thumbUp).toMatchObject({ impact: 30, badge: '+30.0' });
    });

    it('falls back to the cutoff when a culled game has no penalties', () =>
    {
        const { factors } = setup([game('1', { rating: 9.5 }), game('2', { rating: 9.2 })]);
        expect(factors('2')).toEqual([expect.objectContaining({ kind: 'cutoff', badge: '#2' })]);
        expect(factors('2')[0].lines[1]).toBe('You’re keeping the top 1 (target 1).');
    });

    it('lists must keep first', () =>
    {
        const { factors } = setup([game('1', { rating: 6 })], { '1': { mustKeep: true } });
        expect(factors('1')[0].kind).toBe('mustKeep');
    });
});

describe('cullExplanation', () =>
{
    it('summarises negative factors for the CSV export', () =>
    {
        const { state, result } = setup([peer('1', 8.5), peer('2', 6.0)], { '2': { thumb: -1 } });
        const text = cullExplanation(result.cull[0], state, result);
        expect(text).toBe('Rating 6.0/10 (6.0); Your thumbs down (−30.0); Similar to Peer 1 (−20.0); Below your rating threshold (−15.0)');
    });
});
