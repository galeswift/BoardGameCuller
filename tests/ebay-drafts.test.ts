import { describe, expect, it } from 'vitest';
import { UNDERCUT, defaultTitle, draftsCsv, listingHtml, undercutPrice, type EbayDraft } from '@/lib/ebay-drafts';

const draft = (extra: Partial<EbayDraft> = {}): EbayDraft => ({
    id: '13',
    name: 'Catan',
    title: 'Catan Board Game - Catan Studio',
    price: 32,
    condition: 'Used',
    description: 'Trade, build, settle.\n\nGreat with 4.',
    notes: '',
    facts: ['Players: 3–4', 'Play time: about 90 minutes'],
    ...extra,
});

describe('defaultTitle', () =>
{
    it('adds the publisher when it fits in 80 characters', () =>
    {
        expect(defaultTitle('Catan', 'Catan Studio')).toBe('Catan Board Game - Catan Studio');
        expect(defaultTitle('Catan', '')).toBe('Catan Board Game');
    });
    it('drops the publisher, then the suffix, to stay within 80', () =>
    {
        const long = 'A'.repeat(65);

        expect(defaultTitle(long, 'Very Long Publisher Name')).toBe(`${long} Board Game`);
        expect(defaultTitle('B'.repeat(90), '')).toHaveLength(80);
    });
});

describe('listingHtml', () =>
{
    it('builds paragraphs, facts and a condition section, escaping text', () =>
    {
        const html = listingHtml(draft({ name: 'Cards & <Dice>', notes: 'Sleeved.\nAll there.' }));

        expect(html).toContain('<h2>Cards &amp; &lt;Dice&gt;</h2>');
        expect(html).toContain('<p>Trade, build, settle.</p><p>Great with 4.</p>');
        expect(html).toContain('<ul><li>Players: 3–4</li><li>Play time: about 90 minutes</li></ul>');
        expect(html).toContain('<h3>Condition</h3><p>Used and played.');
        expect(html).toContain('<p>Sleeved.<br>All there.</p>');
    });
});

describe('draftsCsv', () =>
{
    const lines = draftsCsv([draft(), draft({ id: '7', title: 'Say "Hi", ok', price: null, condition: 'New' })]).split('\r\n');

    it("starts with eBay's draft template info and header rows", () =>
    {
        expect(lines[0]).toBe('#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,');
        expect(lines[1]).toBe(
            'Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8),Custom label (SKU),Category ID,Title,UPC,Price,Quantity,Item photo URL,Condition ID,Description,Format'
        );
    });

    it('writes one Draft row per game in the board games category', () =>
    {
        expect(lines[2]).toMatch(/^Draft,BGG-13,180349,Catan Board Game - Catan Studio,,32\.00,1,,3000,"<h2>Catan<\/h2>.*",FixedPrice$/);
        expect(lines[3]).toMatch(/^Draft,BGG-7,180349,"Say ""Hi"", ok",,,1,,1000,/);
        expect(lines.at(-1)).toBe('');
    });

    it('keeps each listing on one line', () =>
    {
        expect(lines).toHaveLength(5);
        expect(lines[2]).not.toMatch(/\n/);
    });

    it('maps unpunched and near-mint copies to Used with an explanation', () =>
    {
        const row = draftsCsv([draft({ condition: 'Unpunched' })]).split('\r\n')[2];

        expect(row).toContain(',3000,');
        expect(row).toContain('Opened but never played');
    });
});

describe('undercutPrice', () =>
{
    it('suggests 10% under the market estimate, to the cent', () =>
    {
        expect(UNDERCUT).toBe(0.1);
        expect(undercutPrice(25.5)).toBe(22.95);
        expect(undercutPrice(42)).toBe(37.8);
        expect(undercutPrice(19.99)).toBe(17.99);
    });
});
