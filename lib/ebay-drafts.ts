import type { Condition } from './model';

// eBay Seller Hub "create drafts" upload file (Seller Hub → Reports → Uploads).
// Drafts accept only these columns; shipping and business policies are set in
// Seller Hub afterwards, along with photos.
export const EBAY_BOARD_GAMES_CATEGORY = '180349'; // Toys & Hobbies › Games › Board & Traditional Games › Contemporary Manufacture
const INFO = ['#INFO', 'Version=0.0.2', 'Template= eBay-draft-listings-template_US'];
const HEADER = [
    'Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)',
    'Custom label (SKU)',
    'Category ID',
    'Title',
    'UPC',
    'Price',
    'Quantity',
    'Item photo URL',
    'Condition ID',
    'Description',
    'Format',
];

export const TITLE_MAX = 80;

/** Suggested prices undercut the market estimate by this much, to sell quickly. */
export const UNDERCUT = 0.1;

export const undercutPrice = (marketMedian: number) => Math.round(marketMedian * (1 - UNDERCUT) * 100) / 100;

/** eBay condition per trade-in condition. Unpunched is listed as Used with an explanatory note. */
export const EBAY_CONDITION: Record<Condition, { id: '1000' | '3000'; text: string }> = {
    New: { id: '1000', text: 'New and sealed in the original shrinkwrap.' },
    Unpunched: { id: '3000', text: 'Opened but never played: the components are unpunched and still in their original wrapping.' },
    Used: { id: '3000', text: 'Used and played. Please see the photos for the box and components.' },
    'Near Mint (Books Only)': { id: '3000', text: 'Near mint: like new, with no creases, tears or markings.' },
};

export type EbayDraft = {
    id: string;
    name: string;
    title: string;
    price: number | null;
    condition: Condition;
    description: string;
    notes: string;
    facts: string[];
};

export function defaultTitle(name: string, publisher: string)
{
    const base = `${name} Board Game`;
    const withPublisher = publisher ? `${base} - ${publisher}` : base;

    return (withPublisher.length <= TITLE_MAX ? withPublisher : base.length <= TITLE_MAX ? base : name).slice(0, TITLE_MAX);
}

const html = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
const paragraphs = (text: string) =>
    text
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
        .map(paragraph => `<p>${html(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');

export function listingHtml(draft: EbayDraft)
{
    return [
        `<h2>${html(draft.name)}</h2>`,
        paragraphs(draft.description),
        draft.facts.length ? `<ul>${draft.facts.map(fact => `<li>${html(fact)}</li>`).join('')}</ul>` : '',
        `<h3>Condition</h3><p>${html(EBAY_CONDITION[draft.condition].text)}</p>`,
        paragraphs(draft.notes),
    ].join('');
}

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function draftsCsv(drafts: EbayDraft[])
{
    const rows = drafts.map(draft => [
        'Draft',
        `BGG-${draft.id}`,
        EBAY_BOARD_GAMES_CATEGORY,
        draft.title.slice(0, TITLE_MAX),
        '',
        draft.price != null && draft.price > 0 ? draft.price.toFixed(2) : '',
        '1',
        '',
        EBAY_CONDITION[draft.condition].id,
        // One line per listing keeps the upload parser happy.
        listingHtml(draft).replace(/[\r\n]+/g, ' '),
        'FixedPrice',
    ]);
    const pad = (cells: string[]) => [...cells, ...Array(HEADER.length - cells.length).fill('')];

    return [pad(INFO), HEADER, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
