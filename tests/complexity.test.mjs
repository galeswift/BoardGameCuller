import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { calculate, complexitySimilarity, defaults } from '../lib/model.ts';

const game = (id, complexity, rating = 8) => ({
    id: String(id),
    name: `Game ${id}`,
    type: 'standalone',
    rating,
    personalRating: null,
    complexity,
    minutes: 60,
    minPlayers: 2,
    maxPlayers: 4,
    mean: null,
    group: 'Shared experience',
    theme: 'Shared theme',
    mode: 'Competitive',
    notes: '',
});
const state = (games, preferences = {}) => ({ games, preferences, settings: { ...defaults, target: 1 }, savedAt: null });

test('a 3.5 versus 2.0 mismatch cannot be outweighed by identical other features', () =>
{
    const result = calculate(state([game(1, 3.5, 9), game(2, 2, 7)]));
    for (const g of result.ranked)
    {
        assert.equal(g.alternative, '');
        assert.equal(g.overlap, 0);
    }
});

test('the logarithmic difficulty model admits nearby weights and accelerates its penalty', () =>
{
    assert.equal(complexitySimilarity(2, 2), 1);
    assert.ok(complexitySimilarity(2, 2.5) > 0);
    assert.equal(complexitySimilarity(2, 2.6), null);
    const firstDrop = 1 - complexitySimilarity(2, 2.2);
    const secondDrop = complexitySimilarity(2, 2.2) - complexitySimilarity(2, 2.4);
    assert.ok(secondDrop > firstDrop);
    assert.equal(complexitySimilarity(2, 2.5), complexitySimilarity(2.5, 2));
});

test('missing or invalid complexity cannot create a substitute', () =>
{
    for (const weight of [null, 0, NaN, Infinity, 6]) assert.equal(complexitySimilarity(2, weight), null);
    const result = calculate(state([game(1, 2), game(2, null)]));
    assert.ok(result.ranked.every(g => g.overlap === 0 && g.alternative === ''));
});

test('light and heavy peers get their own directly compatible representatives', () =>
{
    const result = calculate(state([game(1, 3.5, 9), game(2, 3.7, 8), game(3, 2, 8.5), game(4, 2.2, 7.5)]));
    assert.equal(result.ranked.find(g => g.id === '2').alternative, '1');
    assert.equal(result.ranked.find(g => g.id === '4').alternative, '3');
    assert.equal(result.protectedCount, 2);
    assert.ok(result.kept.has('1') && result.kept.has('3'));
});

test('an intermediate weight cannot bridge two incompatible games', () =>
{
    const result = calculate(state([game(1, 2, 9), game(2, 2.5, 8.5), game(3, 3, 8)]));
    assert.equal(result.ranked.find(g => g.id === '2').alternative, '1');
    assert.equal(result.ranked.find(g => g.id === '3').alternative, '');
});

test('different play groups or modes remain independent', () =>
{
    for (const patch of [{ group: 'Other experience' }, { mode: 'Cooperative' }])
    {
        const result = calculate(state([game(1, 2), { ...game(2, 2), ...patch }]));
        assert.ok(result.ranked.every(g => g.alternative === ''));
    }
});

test('collection recalculation preserves preferences and all alternatives pass the gate', () =>
{
    const games = JSON.parse(readFileSync(new URL('../lib/collection.json', import.meta.url), 'utf8'));
    const lockedId = games.find(g => g.type === 'standalone').id;
    const input = state(games, { [lockedId]: { thumb: 1, mustKeep: true, reviewed: true, box: 3, notes: 'Preserve this choice' } });
    input.settings.target = 192;
    const before = JSON.stringify(input);
    const result = calculate(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(result.ranked.length, 292);
    assert.equal(result.cull.length, 100);
    assert.ok(result.kept.has(lockedId));
    for (const g of result.ranked)
    {
        if (!g.alternative) continue;
        const rep = result.ranked.find(other => other.id === g.alternative);
        assert.notEqual(complexitySimilarity(g.complexity, rep.complexity), null, `${g.name} / ${rep.name}`);
    }
});
