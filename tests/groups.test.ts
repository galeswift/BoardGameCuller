import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { assignGroups, groupPrompt, vocabulary } from '@/lib/groups';
import { game } from './helpers';

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function openAiReply(content: unknown)
{
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

function sentPrompt()
{
    return JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).messages as { role: string; content: string }[];
}

beforeEach(() =>
{
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('vocabulary', () =>
{
    it('lists groups in use, largest first, with their size and examples', () =>
    {
        const games = [
            game('1', { name: 'Pandemic', group: 'Cooperative crisis puzzles' }),
            game('2', { name: 'Forbidden Island', group: 'Cooperative crisis puzzles' }),
            game('3', { name: 'Azul', group: 'Tile drafting patterns' }),
            game('4', { name: 'Ungrouped' }),
            game('5', { name: 'An expansion', type: 'expansion', group: 'Should be ignored' }),
        ];

        expect(vocabulary(games)).toEqual([
            '- Cooperative crisis puzzles (2 games, e.g. Pandemic; Forbidden Island)',
            '- Tile drafting patterns (1 games, e.g. Azul)',
        ]);
    });
});

describe('groupPrompt', () =>
{
    it('describes each game with its details and the groups to reuse', () =>
    {
        const prompt = groupPrompt(
            [
                {
                    game: game('9', { name: 'Heat', complexity: 2.2, minutes: 60, minPlayers: 1, maxPlayers: 6, mode: 'Competitive' }),
                    details: { categories: ['Racing'], mechanics: ['Hand Management'] } as never,
                },
            ],
            ['- Racing card games (3 games, e.g. Flamme Rouge)']
        );

        expect(prompt).toContain('Existing groups:\n- Racing card games (3 games, e.g. Flamme Rouge)');
        expect(prompt).toContain('9 | Heat | weight 2.2 | 60 min | 1-6p | Competitive | categories: Racing | mechanics: Hand Management');
    });

    it('says when there are no groups yet', () =>
    {
        expect(groupPrompt([{ game: game('1') }], [])).toContain('Existing groups: none yet.');
    });
});

describe('assignGroups', () =>
{
    it('asks OpenAI for JSON and keeps clean groups for the games asked about', async () =>
    {
        // Games 2 and 3 get unusable answers, so they're asked about again (and skipped again).
        fetchMock.mockImplementation(async () =>
            openAiReply({
                groups: {
                    '1': '  Cooperative   crisis puzzles ',
                    '2': '',
                    '3': 42,
                    '99': 'Not one of ours',
                },
            })
        );
        const groups = await assignGroups([{ game: game('1') }, { game: game('2') }, { game: game('3') }], []);

        expect(groups).toEqual({ '1': 'Cooperative crisis puzzles' });
        const [system] = sentPrompt();

        expect(system.content).toContain('Reuse an existing group, spelled exactly the same');
        expect(system.content).toContain("don't split groups by weight or length");
        expect(system.content).toContain('Never create near-duplicate names');
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({
            response_format: { type: 'json_object' },
            max_completion_tokens: 8000,
        });
    });

    it('asks again for games the model skipped, offering the groups it just made', async () =>
    {
        fetchMock
            .mockResolvedValueOnce(openAiReply({ groups: { '1': 'Cooperative crisis puzzles' } }))
            .mockResolvedValueOnce(openAiReply({ groups: { '2': 'Cooperative crisis puzzles' } }));
        const groups = await assignGroups([{ game: game('1') }, { game: game('2', { name: 'Skipped' }) }], []);

        expect(groups).toEqual({ '1': 'Cooperative crisis puzzles', '2': 'Cooperative crisis puzzles' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retry = JSON.parse(String(fetchMock.mock.calls[1][1]!.body)).messages[1].content as string;

        expect(retry).toContain('Existing groups:\n- Cooperative crisis puzzles');
        expect(retry).toContain('2 | Skipped');
        expect(retry).not.toContain('1 | Game 1');
    });

    it("doesn't retry when every game got a group", async () =>
    {
        fetchMock.mockResolvedValue(openAiReply({ groups: { '1': 'A group' } }));
        await assignGroups([{ game: game('1') }], []);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('trims overly long group names', async () =>
    {
        fetchMock.mockResolvedValue(openAiReply({ groups: { '1': 'x'.repeat(80) } }));
        expect((await assignGroups([{ game: game('1') }], []))['1']).toHaveLength(60);
    });
});
