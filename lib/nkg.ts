import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

// Fills Noble Knight Games' trade-in template (public/nkg-trade-template.xlsx).
// Sheet1 columns: A Publisher · B Title · C Condition* · D Comments. Rows are written
// straight into the sheet XML so the template's condition dropdown, colour rules
// and instructions text box survive untouched.
export const NKG_TEMPLATE_PATH = '/nkg-trade-template.xlsx';
const SHEET = 'xl/worksheets/sheet1.xml';

export type TradeInRow = { publisher: string; title: string; condition: string; comments: string };

const escapeXml = (text: string) =>
    text
        .replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
        // Characters XML 1.0 can't carry at all.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const cell = (ref: string, value: string) =>
    value ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>` : '';

export function fillTradeInTemplate(template: Uint8Array, rows: TradeInRow[]): Uint8Array
{
    const files = unzipSync(template);
    const sheet = files[SHEET];

    if (!sheet)
    {
        throw new Error('This isn’t the Noble Knight trade-in template.');
    }

    const xml = strFromU8(sheet);
    const header = xml.match(/<row r="1"[\s\S]*?<\/row>/)?.[0];

    if (!header || !/<sheetData>[\s\S]*<\/sheetData>/.test(xml))
    {
        throw new Error('This isn’t the Noble Knight trade-in template.');
    }

    const body = rows
        .map((row, index) =>
        {
            const rowNumber = index + 2;

            return `<row r="${rowNumber}">${cell(`A${rowNumber}`, row.publisher)}${cell(`B${rowNumber}`, row.title)}${cell(`C${rowNumber}`, row.condition)}${cell(`D${rowNumber}`, row.comments)}</row>`;
        })
        .join('');
    // Replace the sample row and the template's empty formatting rows with ours.
    const filled = xml
        .replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${header}${body}</sheetData>`)
        .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:D${rows.length + 1}"/>`);

    files[SHEET] = strToU8(filled);

    return zipSync(files, { level: 6 });
}
