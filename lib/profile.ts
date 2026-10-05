// A profile is a BGG username; its collection, preferences and settings are stored under it.
export const DEFAULT_PROFILE='galeswift';
export function normalizeProfile(value:unknown):string{
 if(typeof value!=='string')throw new Error('Invalid BGG username.');
 const p=value.trim().toLowerCase();
 if(!/^[a-z0-9_][a-z0-9_ .-]{0,63}$/.test(p))throw new Error('Invalid BGG username.');
 return p;
}
export function defaultProfile(){return normalizeProfile(process.env.DEFAULT_PROFILE||DEFAULT_PROFILE);}
export function resolveProfile(value:unknown){return value==null||value===''?defaultProfile():normalizeProfile(value);}
