import { CONDITIONS, MAX_COLLECTION_GAMES, bggImageUrl, type Preference, type Settings, type Game } from './model';
const bounded = (value: unknown, min: number, max: number, nullable = false) =>
{
    if (nullable && value === null)
    {
        return null;
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    {
        throw new Error('Invalid numeric value.');
    }

    return value;
};

export function preferencePatch(value: unknown): Preference
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error('Invalid preference.');
    }

    const out: Record<string, unknown> = {};

    for (const [field, fieldValue] of Object.entries(value))
    {
        if (['mustKeep', 'reviewed'].includes(field))
        {
            if (typeof fieldValue !== 'boolean')
            {
                throw new Error('Invalid checkbox.');
            }

            out[field] = fieldValue;
        }
        else if (field === 'thumb')
        {
            if (![-1, 0, 1].includes(Number(fieldValue)) || typeof fieldValue !== 'number')
            {
                throw new Error('Invalid thumb.');
            }

            out[field] = fieldValue;
        }
        else if (field === 'box')
        {
            out[field] = bounded(fieldValue, 0, 3, true);
            if (fieldValue !== null && !Number.isInteger(fieldValue))
            {
                throw new Error('Invalid box size.');
            }
        }
        else if (field === 'condition')
        {
            if (fieldValue !== null && !CONDITIONS.includes(fieldValue as never))
            {
                throw new Error('Invalid condition.');
            }

            out[field] = fieldValue;
        }
        else if (field === 'personalRating')
        {
            out[field] = bounded(fieldValue, 1, 10, true);
        }
        else if (field === 'mean')
        {
            out[field] = bounded(fieldValue, 0, 5, true);
        }
        else if (field === 'minutes')
        {
            out[field] = bounded(fieldValue, 1, 1440, true);
        }
        else if (['group', 'theme', 'mode', 'notes'].includes(field))
        {
            if (typeof fieldValue !== 'string' || fieldValue.length > (field === 'notes' ? 2000 : 150))
            {
                throw new Error('Text is too long.');
            }

            out[field] = fieldValue;
        }
        else
        {
            throw new Error('Unknown preference field.');
        }
    }

    return out as Preference;
}

export function settingsPatch(value: unknown): Partial<Settings>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error('Invalid settings.');
    }

    const out: Record<string, unknown> = {};

    for (const [field, fieldValue] of Object.entries(value))
    {
        if (field === 'preserve')
        {
            if (typeof fieldValue !== 'boolean')
            {
                throw new Error('Invalid protection setting.');
            }

            out[field] = fieldValue;
        }
        else if (field === 'target')
        {
            out[field] = bounded(fieldValue, 0, 1000);
            if (!Number.isInteger(fieldValue))
            {
                throw new Error('Target must be a whole number.');
            }
        }
        else if (field === 'lowThreshold')
        {
            out[field] = bounded(fieldValue, 1, 10);
        }
        else if (['ratingWeight', 'lowPenalty', 'overlapWeight', 'meanWeight', 'boxWeight', 'thumbWeight'].includes(field))
        {
            out[field] = bounded(fieldValue, 0, 200);
        }
        else
        {
            throw new Error('Unknown setting.');
        }
    }

    return out;
}

export function validateGames(games: unknown): Game[]
{
    if (!Array.isArray(games) || !games.length || games.length > MAX_COLLECTION_GAMES)
    {
        throw new Error(`Collection must contain 1–${MAX_COLLECTION_GAMES.toLocaleString('en-US')} games.`);
    }

    const ids = new Set<string>();

    return games.map(game =>
    {
        if (
            !game ||
            typeof game !== 'object' ||
            typeof game.id !== 'string' ||
            !/^\d{1,10}$/.test(game.id) ||
            ids.has(game.id) ||
            typeof game.name !== 'string' ||
            !game.name ||
            game.name.length > 300 ||
            !['standalone', 'expansion'].includes(game.type)
        )
        {
            throw new Error('Invalid game or duplicate ID.');
        }

        ids.add(game.id);
        for (const field of ['rating', 'personalRating', 'complexity', 'minutes', 'minPlayers', 'maxPlayers', 'mean'])
        {
            if (game[field] != null)
            {
                bounded(
                    game[field],
                    0,
                    field === 'minutes' ? 1440 : field.includes('Players') ? 100 : field === 'mean' || field === 'complexity' ? 5 : 10
                );
            }
        }

        for (const field of ['group', 'theme', 'mode', 'notes', 'parentId', 'parentName', 'bestPlayers', 'publisher'])
        {
            if (game[field] != null && (typeof game[field] !== 'string' || game[field].length > 2000))
            {
                throw new Error('Invalid game text.');
            }
        }

        for (const field of ['categories', 'mechanics', 'families'])
        {
            const tags = game[field];

            if (
                tags != null &&
                (!Array.isArray(tags) || tags.length > 200 || !tags.every(tag => typeof tag === 'string' && tag.length <= 200))
            )
            {
                throw new Error('Invalid game tags.');
            }
        }

        if (game.thumbnail != null && !bggImageUrl(game.thumbnail))
        {
            throw new Error('Invalid game thumbnail.');
        }

        return game as Game;
    });
}
