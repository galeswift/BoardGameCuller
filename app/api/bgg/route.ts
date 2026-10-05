import {getUser,sameOrigin} from '../../auth';
import {getDb} from '@/db';
import seed from '@/lib/collection.json';
import {BggError,fetchBggCollection} from '@/lib/bgg';
import type {Game} from '@/lib/model';
import {defaultProfile,resolveProfile} from '@/lib/profile';
import {validateGames} from '@/lib/validation';
export const dynamic='force-dynamic';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
// Imports the profile's owned games from BoardGameGeek, replacing its stored collection.
export async function POST(request:Request){
 const user=await getUser();if(!user)return json({error:'Sign in before importing.'},401);
 if(!sameOrigin(request))return json({error:'Request origin does not match.'},403);
 let profile;try{profile=resolveProfile((await request.json())?.profile);}catch(e){return json({error:e instanceof Error&&e.message.startsWith('Invalid')?e.message:'Invalid request.'},400);}
 try{
  const db=await getDb();
  const prior=(await db.query<{games:Game[]|null}>('SELECT games FROM collection_state WHERE owner=$1',[profile])).rows[0]?.games??(profile===defaultProfile()?seed as Game[]:[]);
  const games=validateGames(await fetchBggCollection(profile,prior)),now=new Date().toISOString();
  await db.query("INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,'{}',$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET games=excluded.games,updated=excluded.updated",[profile,JSON.stringify(games),now]);
  return json({games,savedAt:now});
 }catch(e){if(e instanceof BggError)return json({error:e.message},502);console.error('BGG import failed',e);return json({error:'BGG import failed. Please retry.'},503);}
}
