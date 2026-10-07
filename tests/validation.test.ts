import { describe, expect, it } from 'vitest';
import { preferencePatch, settingsPatch, validateGames } from '@/lib/validation';
import { game } from './helpers';

describe('preferencePatch', () =>
{
    it('accepts trade-in conditions, or null for the default', () =>
    {
        expect(preferencePatch({ condition: 'Unpunched' })).toEqual({ condition: 'Unpunched' });
        expect(preferencePatch({ condition: null })).toEqual({ condition: null });
    });

    it('accepts known fields', () =>
    {
        expect(preferencePatch({ thumb: -1, mustKeep: true, box: 2, personalRating: null, notes: 'keep' })).toEqual({
            thumb: -1,
            mustKeep: true,
            box: 2,
            personalRating: null,
            notes: 'keep',
        });
    });

    it.each([
        [{ thumb: 2 }, 'Invalid thumb.'],
        [{ mustKeep: 'yes' }, 'Invalid checkbox.'],
        [{ box: 1.5 }, 'Invalid box size.'],
        [{ personalRating: 11 }, 'Invalid numeric value.'],
        [{ group: 'x'.repeat(151) }, 'Text is too long.'],
        [{ hacked: true }, 'Unknown preference field.'],
        [[], 'Invalid preference.'],
        [{ condition: 'Mint' }, 'Invalid condition.'],
    ])('rejects %j', (patch, message) =>
    {
        expect(() => preferencePatch(patch)).toThrow(message);
    });
});

describe('settingsPatch', () =>
{
    it('accepts bounded settings', () =>
    {
        expect(settingsPatch({ target: 50, preserve: false, ratingWeight: 80 })).toEqual({ target: 50, preserve: false, ratingWeight: 80 });
    });

    it('rejects fractional targets and unknown keys', () =>
    {
        expect(() => settingsPatch({ target: 1.5 })).toThrow('Target must be a whole number.');
        expect(() => settingsPatch({ nope: 1 })).toThrow('Unknown setting.');
    });
});

describe('validateGames', () =>
{
    it('accepts a well-formed collection', () =>
    {
        expect(validateGames([game('1'), game('2', { type: 'expansion', parentId: '1', parentName: 'Game 1' })])).toHaveLength(2);
    });

    it('rejects empty, duplicate and malformed collections', () =>
    {
        expect(() => validateGames([])).toThrow('Collection must contain');
        expect(() => validateGames([game('1'), game('1')])).toThrow('duplicate ID');
        expect(() => validateGames([game('abc')])).toThrow('duplicate ID');
        expect(() => validateGames([game('1', { complexity: 9 })])).toThrow('Invalid numeric value.');
        expect(() => validateGames([game('1', { mechanics: 'Dice Rolling' as unknown as string[] })])).toThrow('Invalid game tags.');
        expect(() => validateGames([game('1', { families: [7 as unknown as string] })])).toThrow('Invalid game tags.');
    });

    it('accepts only BGG image-CDN thumbnails that are safe inside CSS', () =>
    {
        const thumbnail = 'https://cf.geekdo-images.com/abc__small/img/x=/fit-in/200x150/filters:strip_icc()/pic1.jpg';

        expect(validateGames([game('1', { thumbnail })])[0].thumbnail).toBe(thumbnail);
        expect(() => validateGames([game('1', { thumbnail: 'https://evil.example/x.jpg' })])).toThrow('Invalid game thumbnail.');
        expect(() => validateGames([game('1', { thumbnail: 'https://cf.geekdo-images.com/a")' })])).toThrow('Invalid game thumbnail.');
    });
});
