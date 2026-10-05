import {getUser,sameOrigin} from '../../auth';
import {getDb} from '@/db';
import seed from '@/lib/collection.json';
import {defaults,type Game,type Preference,type Settings} from '@/lib/model';
import {preferencePatch,settingsPatch,validateGames} from '@/lib/validation';
import {preferenceWrite} from '@/lib/preference-sql';
import {defaultProfile,resolveProfile} from '@/lib/profile';
export const dynamic='force-dynamic';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request){
 const user=await getUser();if(!user)return json({error:'Sign in to load your saved collection.'},401);
 let profile;try{profile=resolveProfile(new URL(request.url).searchParams.get('profile'));}catch(e){return json({error:(e as Error).message},400);}
 try{const db=await getDb();const [state,prefs,owners]=await Promise.all([db.query<{settings:Partial<Settings>;games:Game[]|null;updated:string}>('SELECT settings,games,updated FROM collection_state WHERE owner=$1',[profile]),db.query<{game_id:string;data:Preference;updated:string}>('SELECT game_id,data,updated FROM preferences WHERE owner=$1',[profile]),db.query<{owner:string}>('SELECT owner FROM collection_state ORDER BY owner')]);
  const s=state.rows[0];const timestamps=[s?.updated,...prefs.rows.map(p=>p.updated)].filter(Boolean).sort();return json({profile,profiles:owners.rows.map(o=>o.owner),games:s?.games??(profile===defaultProfile()?seed:[]),settings:{...defaults,...s?.settings},preferences:Object.fromEntries(prefs.rows.map(p=>[p.game_id,p.data])),savedAt:timestamps.at(-1)||null});
 }catch(e){console.error('Collection load failed',e);return json({error:'Your saved collection is temporarily unavailable. Please retry.'},503);}
}
export async function POST(request:Request){
 const user=await getUser();if(!user)return json({error:'Sign in before saving preferences.'},401);
 if(!sameOrigin(request))return json({error:'Request origin does not match.'},403);
 if(Number(request.headers.get('content-length')||0)>1500000)return json({error:'Import is too large.'},413);
 let payload;try{const text=await request.text();if(text.length>1500000)return json({error:'Import is too large.'},413);payload=JSON.parse(text);}catch{return json({error:'Invalid request.'},400);}
 try{
  const db=await getDb(),now=new Date().toISOString(),owner=resolveProfile(payload.profile);
  const preferenceStatement=(id:string,p:unknown)=>{if(typeof id!=='string'||!/^\d{1,10}$/.test(id))throw new Error('Invalid BGG ID.');const patch=preferencePatch(p);if(!Object.keys(patch).length)throw new Error('Invalid empty preference.');return preferenceWrite(owner,id,patch as Record<string,unknown>,now);};
  if(payload.action==='preference'){const s=preferenceStatement(payload.id,payload.patch);await db.query(s.sql,s.values);}
  else if(payload.action==='settings'){const patch=settingsPatch(payload.patch);await db.query('INSERT INTO collection_state(owner,settings,updated) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET settings=collection_state.settings||excluded.settings,updated=excluded.updated',[owner,JSON.stringify(patch),now]);}
  else if(payload.action==='collection'){const games=validateGames(payload.games);await db.query("INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,'{}',$2::jsonb,$3) ON CONFLICT(owner) DO UPDATE SET games=excluded.games,updated=excluded.updated",[owner,JSON.stringify(games),now]);}
  else if(payload.action==='restore'){const b=payload.backup;if(b?.format!=='collection-cull-v1')throw new Error('Choose a Collection Cull backup.');const games=validateGames(b.games),s=settingsPatch(b.settings),prefs=b.preferences;if(!prefs||typeof prefs!=='object'||Array.isArray(prefs)||Object.keys(prefs).length>2000)throw new Error('Invalid preferences backup.');
   const statements=[{sql:'INSERT INTO collection_state(owner,settings,games,updated) VALUES($1,$2::jsonb,$3::jsonb,$4) ON CONFLICT(owner) DO UPDATE SET settings=excluded.settings,games=excluded.games,updated=excluded.updated',values:[owner,JSON.stringify(s),JSON.stringify(games),now]},{sql:'DELETE FROM preferences WHERE owner=$1',values:[owner]},...Object.entries(prefs).filter(([,p])=>Object.keys(p as object).length>0).map(([id,p])=>preferenceStatement(id,p))];
   const client=await db.connect();try{await client.query('BEGIN');for(const st of statements)await client.query(st.sql,st.values);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }else throw new Error('Unknown action.');
  return json({savedAt:now});
 }catch(e){const msg=e instanceof Error?e.message:'';if(/Invalid|Unknown|must|too long|Choose|Collection|Duplicate|Target/.test(msg))return json({error:msg},400);console.error('Preference save failed',e);return json({error:'Saving failed. Your changes are still on this page. Retry to save them.'},503);}
}
