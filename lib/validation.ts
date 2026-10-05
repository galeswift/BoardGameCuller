import {CONDITIONS,type Preference,type Settings,type Game} from './model';
const bounded=(v:unknown,min:number,max:number,nullable=false)=>{if(nullable&&v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('Invalid numeric value.');return v;};
export function preferencePatch(value:unknown):Preference {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid preference.');
 const out:Record<string,unknown>={};
 for(const [k,v] of Object.entries(value)){
  if(['mustKeep','reviewed'].includes(k)){if(typeof v!=='boolean')throw new Error('Invalid checkbox.');out[k]=v;}
  else if(k==='thumb'){if(![-1,0,1].includes(Number(v))||typeof v!=='number')throw new Error('Invalid thumb.');out[k]=v;}
  else if(k==='box'){out[k]=bounded(v,0,3,true);if(v!==null&&!Number.isInteger(v))throw new Error('Invalid box size.');}
  else if(k==='condition'){if(v!==null&&!CONDITIONS.includes(v as never))throw new Error('Invalid condition.');out[k]=v;}
  else if(k==='personalRating')out[k]=bounded(v,1,10,true);
  else if(k==='mean')out[k]=bounded(v,0,5,true);
  else if(k==='minutes')out[k]=bounded(v,1,1440,true);
  else if(['group','theme','mode','notes'].includes(k)){if(typeof v!=='string'||v.length>(k==='notes'?2000:150))throw new Error('Text is too long.');out[k]=v;}
  else throw new Error('Unknown preference field.');
 }
 return out as Preference;
}
export function settingsPatch(value:unknown):Partial<Settings>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid settings.');const out:Record<string,unknown>={};
 for(const [k,v] of Object.entries(value)){if(k==='preserve'){if(typeof v!=='boolean')throw new Error('Invalid protection setting.');out[k]=v;}else if(k==='target'){out[k]=bounded(v,0,1000);if(!Number.isInteger(v))throw new Error('Target must be a whole number.');}else if(k==='lowThreshold')out[k]=bounded(v,1,10);else if(['ratingWeight','lowPenalty','overlapWeight','meanWeight','boxWeight','thumbWeight'].includes(k))out[k]=bounded(v,0,200);else throw new Error('Unknown setting.');}return out;
}
export function validateGames(v:unknown):Game[]{
 if(!Array.isArray(v)||!v.length||v.length>1000)throw new Error('Collection must contain 1–1,000 games.');
 const ids=new Set<string>();
 return v.map(g=>{if(!g||typeof g!=='object'||typeof g.id!=='string'||!/^\d{1,10}$/.test(g.id)||ids.has(g.id)||typeof g.name!=='string'||!g.name||g.name.length>300||!['standalone','expansion'].includes(g.type))throw new Error('Invalid game or duplicate ID.');ids.add(g.id);
  for(const k of ['rating','personalRating','complexity','minutes','minPlayers','maxPlayers','mean'])if(g[k]!=null)bounded(g[k],0,k==='minutes'?1440:k.includes('Players')?100:k==='mean'||k==='complexity'?5:10);
  for(const k of ['group','theme','mode','notes','parentId','parentName','bestPlayers','publisher'])if(g[k]!=null&&(typeof g[k]!=='string'||g[k].length>2000))throw new Error('Invalid game text.');
  return g as Game;
 });
}
