import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fillTradeInTemplate } from '@/lib/nkg';

const template = new Uint8Array(readFileSync(new URL('../public/nkg-trade-template.xlsx', import.meta.url)));
const sheet = (xlsx: Uint8Array) => strFromU8(unzipSync(xlsx)['xl/worksheets/sheet1.xml']);

describe('fillTradeInTemplate', () =>
{
    const rows = [
        { publisher: 'Stonemaier Games', title: 'Wingspan', condition: 'Used', comments: '' },
        { publisher: '', title: 'Cards & <Dice> "Deluxe"', condition: 'Unpunched', comments: 'Missing 1 meeple' },
    ];
    const xml = sheet(fillTradeInTemplate(template, rows));

    it('writes one row per game under the header', () =>
    {
        expect(xml).toContain(
            '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">Stonemaier Games</t></is></c><c r="B2" t="inlineStr"><is><t xml:space="preserve">Wingspan</t></is></c><c r="C2" t="inlineStr"><is><t xml:space="preserve">Used</t></is></c></row>'
        );
        expect(xml).toContain('<c r="D3" t="inlineStr"><is><t xml:space="preserve">Missing 1 meeple</t></is></c>');
        expect(xml).toContain('<dimension ref="A1:D3"/>');
    });

    it('escapes XML and skips empty cells', () =>
    {
        expect(xml).toContain('Cards &amp; &lt;Dice&gt; &quot;Deluxe&quot;');
        expect(xml).not.toContain('r="A3"');
    });

    it('keeps the header, condition dropdown, colour rules and instructions', () =>
    {
        const files = unzipSync(fillTradeInTemplate(template, rows));

        expect(xml).toMatch(/<row r="1"[^>]*>.*<\/row><row r="2">/);
        expect(xml).toContain('<dataValidation type="list"');
        expect(xml).toContain('<conditionalFormatting');
        expect(xml).toContain('<drawing r:id="rId2"/>');
        expect(files['xl/drawings/drawing1.xml']).toBeDefined();
        expect(Object.keys(files).sort()).toEqual(Object.keys(unzipSync(template)).sort());
    });

    it("drops the template's sample row", () =>
    {
        expect(sheet(fillTradeInTemplate(template, []))).not.toContain('r="C2"');
    });

    it("rejects files that aren't the template", () =>
    {
        expect(() => fillTradeInTemplate(new Uint8Array([1, 2, 3]), [])).toThrow();
    });
});
