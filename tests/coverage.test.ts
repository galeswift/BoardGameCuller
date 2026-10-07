import { describe, expect, it } from 'vitest';
import { calculate, defaults, type Game, type State } from '@/lib/model';
import { coverage, coverageSummary } from '@/lib/coverage';
import { game } from './helpers';

function coverageFor(games: Game[], target: number)
{
    const state: State = { games, preferences: {}, settings: { ...defaults, target }, savedAt: null };
    const result = calculate(state);

    return { result, summary: coverage(result.ranked, result.kept) };
}

const games = [
    game('1', { name: 'Big Euro', rating: 8.5, complexity: 3.8, group: 'Heavy euros', mechanics: ['Worker Placement'] }),
    game('2', { name: 'Other Euro', rating: 8, complexity: 3.6, group: 'Heavy euros', mechanics: ['Worker Placement'] }),
    game('3', { name: 'Party Thing', rating: 6, complexity: 1.2, maxPlayers: 10, group: 'Party', categories: ['Party Game'] }),
];

describe('coverage', () =>
{
    it('counts each broad experience before and after the cull', () =>
    {
        const { summary } = coverageFor(games, 2);
        const byLabel = Object.fromEntries(summary.experiences.map(experience => [experience.label, experience]));

        expect(byLabel['Heavy strategy']).toMatchObject({ before: 2, kept: 2 });
        expect(byLabel['Party games']).toMatchObject({ before: 1, kept: 0, culled: ['Party Thing'] });
        expect(summary.lost.map(experience => experience.label)).toEqual(
            expect.arrayContaining(['Party games', 'Big groups (6+)', 'Light and family games'])
        );
        // Experiences nobody owns aren't listed at all.
        expect(byLabel['Trick-taking']).toBeUndefined();
    });

    it('measures the headline share by play groups that keep a game', () =>
    {
        const { summary } = coverageFor(games, 2);

        expect(summary.groupCount).toBe(2);
        expect(summary.share).toBe(0.5);
        expect(summary.lostGroups).toEqual([{ group: 'Party', games: ['Party Thing'] }]);
        expect(coverageSummary(summary, 1)[0]).toBe(
            'Letting go of these 1 game keeps 50% of your play experiences: 1 of 2 play groups still have a game.'
        );
    });

    it('says when nothing broad is lost', () =>
    {
        const { summary } = coverageFor(games, 3);

        expect(summary.share).toBe(1);
        expect(coverageSummary(summary, 0)[1]).toBe('Every broad kind of game you own still has a place on your shelf.');
    });

    it('leaves out tag-based experiences until games have BGG tags', () =>
    {
        const untagged = games.map(entry => ({ ...entry, categories: undefined, mechanics: undefined }));
        const labels = coverageFor(untagged, 2).summary.experiences.map(experience => experience.label);

        expect(labels).toContain('Heavy strategy');
        expect(labels).not.toContain('Worker placement');
    });
});
