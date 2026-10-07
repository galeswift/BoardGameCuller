// Shallow-merges the patch's top-level keys into the stored preference, like the original json_set.
export function preferenceWrite(owner: string, id: string, patch: Record<string, unknown>, now: string)
{
    return {
        sql: 'INSERT INTO preferences(owner,game_id,data,updated) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(owner,game_id) DO UPDATE SET data=preferences.data||excluded.data,updated=excluded.updated',
        values: [owner, id, JSON.stringify(patch), now],
    };
}
