// Text from BGG's API arrives with HTML entities, often double-encoded
// (e.g. "&amp;#039;" for an apostrophe and "&amp;#10;" for a line break).

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    eacute: 'é',
    uuml: 'ü',
    ouml: 'ö',
    auml: 'ä',
};

export function decodeEntities(text: string): string
{
    let out = text;

    // Twice, to undo double encoding.
    for (let pass = 0; pass < 2; pass++)
    {
        out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) =>
        {
            if (entity[0] !== '#')
            {
                return ENTITIES[entity.toLowerCase()] ?? match;
            }

            const hex = entity[1] === 'x' || entity[1] === 'X';

            return String.fromCodePoint(hex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
        });
    }

    return out
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
