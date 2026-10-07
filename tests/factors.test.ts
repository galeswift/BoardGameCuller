import { describe, expect, it } from 'vitest';
import {
    calculate,
    cullExplanation,
    cullReasons,
    defaults,
    keepFactors,
    tagRarity,
    tagSimilarity,
    type Preference,
    type State,
} from '@/lib/model';
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
            result.ranked.find(entry => entry.id === id)!,
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
        const overlap = factors('2').find(factor => factor.kind === 'overlap')!;

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
        const kinds = factors('2').map(factor => factor.kind);

        expect(kinds).toEqual(['rating', 'thumbDown', 'overlap', 'lowRating', 'box']);
        const impacts = factors('2').map(factor => Math.abs(factor.impact));

        expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    });

    it('describes rating, threshold, mean and box penalties with short badges', () =>
    {
        const { factors } = setup([game('1', { rating: 9 }), game('2', { rating: 6, mean: 3 })], { '2': { box: 2 } }, { meanWeight: 10 });
        const byKind = Object.fromEntries(factors('2').map(factor => [factor.kind, factor]));

        expect(byKind.rating).toMatchObject({ badge: '6.0', title: 'Rating 6.0/10' });
        expect(byKind.rating.lines[0]).toContain('BGG average');
        expect(byKind.lowRating).toMatchObject({ badge: '−15.0', impact: -15 });
        expect(byKind.mean).toMatchObject({ title: 'Mean interaction 3/5', badge: '−6.0' });
        expect(byKind.box).toMatchObject({ title: 'Large box', badge: '−2.0' });
    });

    it('ignores mean interaction unless its deduction is raised', () =>
    {
        const { factors } = setup([game('1', { rating: 9 }), game('2', { rating: 6, mean: 5 })]);

        expect(factors('2').map(factor => factor.kind)).not.toContain('mean');
    });

    it('uses your own rating when set, and shows thumbs up as a positive', () =>
    {
        const { factors } = setup([game('1', { rating: 6 })], { '1': { personalRating: 8, thumb: 1 } });
        const byKind = Object.fromEntries(factors('1').map(factor => [factor.kind, factor]));

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

describe('tag similarity', () =>
{
    const rarity = tagRarity([
        ['category:Fantasy', 'mechanic:Dice Rolling', 'mechanic:Role Playing'],
        ['category:Fantasy', 'mechanic:Dice Rolling', 'mechanic:Worker Placement'],
        ['category:Fantasy', 'mechanic:Dice Rolling', 'mechanic:Role Playing'],
        ['category:Fantasy', 'mechanic:Trick-taking'],
    ]);

    it('scores identical tags as a full match and disjoint tags as none', () =>
    {
        expect(tagSimilarity(['mechanic:Role Playing'], ['mechanic:Role Playing'], rarity).score).toBe(1);
        expect(tagSimilarity(['mechanic:Role Playing'], ['mechanic:Trick-taking'], rarity)).toEqual({ score: 0, shared: [] });
    });

    it('weighs a shared rare tag above a shared common one', () =>
    {
        const rare = tagSimilarity(
            ['category:Fantasy', 'mechanic:Role Playing'],
            ['mechanic:Role Playing', 'mechanic:Trick-taking'],
            rarity
        );
        const common = tagSimilarity(['category:Fantasy', 'mechanic:Role Playing'], ['category:Fantasy', 'mechanic:Trick-taking'], rarity);

        expect(rare.score).toBeGreaterThan(common.score);
        expect(rare.shared).toEqual(['Role Playing']);
    });

    it('lowers similarity for games in one group that share few BGG tags', () =>
    {
        const tagged = (id: string, mechanics: string[]) => peer(id, id === '1' ? 8.5 : 7.5, { categories: ['Fantasy'], mechanics });
        const games = [
            tagged('1', ['Cooperative Game', 'Role Playing', 'Narrative Choice / Paragraph']),
            tagged('2', ['Cooperative Game', 'Worker Placement', 'Tech Trees / Tech Tracks']),
            // Others in the collection make Fantasy and Cooperative common tags.
            ...['3', '4'].map(id => ({ ...tagged(id, ['Cooperative Game']), group: '' })),
        ];
        const untagged = setup(games.map(entry => ({ ...entry, categories: undefined, mechanics: undefined }))).result;
        const withTags = setup(games);
        const similarity = (result: typeof untagged) => result.ranked.find(entry => entry.id === '2')!.similarity;

        expect(similarity(untagged)).toBeGreaterThan(0.9);
        expect(similarity(withTags.result)).toBeGreaterThan(0.3);
        expect(similarity(withTags.result)).toBeLessThan(0.7);
        expect(withTags.result.ranked.find(entry => entry.id === '2')!.match?.tags).toBeTypeOf('number');
    });

    it('explains the tag match and the tags both games share', () =>
    {
        const { factors } = setup([
            peer('1', 8.5, { categories: ['Fantasy'], mechanics: ['Deck Building', 'Hand Management'] }),
            peer('2', 7.5, { categories: ['Fantasy'], mechanics: ['Deck Building', 'Hand Management'] }),
        ]);
        const overlap = factors('2').find(factor => factor.kind === 'overlap')!;

        expect(overlap.lines).toContain(
            'BGG categories, mechanisms and families · 100% match (both: Fantasy, Deck Building, Hand Management)'
        );
    });
});

describe('cullReasons', () =>
{
    function reasonsFor(games: ReturnType<typeof game>[], preferences: Record<string, Preference> = {}, target = 1)
    {
        const { state, result } = setup(games, preferences, { target });

        return (id: string) =>
            cullReasons(
                result.ranked.find(entry => entry.id === id)!,
                state,
                result
            );
    }

    it('puts the rating first, then the game you are keeping instead', () =>
    {
        const reasons = reasonsFor([peer('1', 8.5), peer('2', 6.5)], { '2': { thumb: -1 } });

        expect(reasons('2')).toEqual([
            'BGG players rate it 6.5, below your 7.0 bar.',
            'You gave it a thumbs down.',
            'You’re keeping Peer 1, which gives you the same kind of game (Engine builders).',
        ]);
    });

    it('uses your own rating when you have one', () =>
    {
        const reasons = reasonsFor([game('1', { rating: 9 }), game('2', { rating: 8 })], { '2': { personalRating: 6 } });

        expect(reasons('2')[0]).toBe('You rated it 6.0, below your 7.0 bar.');
    });

    it('explains a game that only misses the cut on rating', () =>
    {
        const reasons = reasonsFor([game('1', { rating: 9 }), game('2', { rating: 8.5 }), game('3', { rating: 7.5 })], {}, 2);

        expect(reasons('3')).toEqual(['BGG players rate it 7.5, lower than most of the games you’re keeping.']);
    });

    it('mentions a big box only when it is large or oversized', () =>
    {
        const big = reasonsFor([game('1', { rating: 9 }), game('2', { rating: 8 })], { '2': { box: 3 } });
        const standard = reasonsFor([game('1', { rating: 9 }), game('2', { rating: 8 })], { '2': { box: 1 } });

        expect(big('2')).toContain('Its big box takes a lot of shelf space.');
        expect(standard('2')).not.toContain('Its big box takes a lot of shelf space.');
    });
});
