export type Game={id:string;name:string;type:'standalone'|'expansion';rating:number|null;personalRating:number|null;complexity:number|null;minutes:number|null;minPlayers:number|null;maxPlayers:number|null;bestPlayers?:string;mean:number|null;group:string;theme:string;mode:string;notes:string;parentId?:string;parentName?:string};
export type Preference={thumb?:number;mustKeep?:boolean;reviewed?:boolean;box?:number|null;personalRating?:number|null;mean?:number|null;group?:string;theme?:string;mode?:string;minutes?:number|null;notes?:string};
export type Settings={target:number;ratingWeight:number;lowThreshold:number;lowPenalty:number;overlapWeight:number;meanWeight:number;boxWeight:number;thumbWeight:number;preserve:boolean};
export type State={games:Game[];preferences:Record<string,Preference>;settings:Settings;savedAt:string|null};
export const defaults:Settings={target:192,ratingWeight:70,lowThreshold:7,lowPenalty:15,overlapWeight:20,meanWeight:10,boxWeight:3,thumbWeight:30,preserve:true};
export const nameKey=(name:string)=>name.replace(/^(the |a |an )/i,'').toLowerCase();
// Modeling choice, not a calibrated BGG conversion: a one-point increase in
// weight doubles a difficulty proxy. Substitutes must be within 50% of one
// another in that proxy (about 0.585 BGG weight points).
const maxDifficultyRatio=1.5;
export function complexitySimilarity(a:number|null,b:number|null):number|null{
 if(a==null||b==null||!Number.isFinite(a)||!Number.isFinite(b)||a<1||a>5||b<1||b>5)return null;
 const relativeDifficultyGap=Math.expm1(Math.LN2*Math.abs(a-b));
 if(relativeDifficultyGap>maxDifficultyRatio-1+1e-12)return null;
 return Math.max(0,1-relativeDifficultyGap/(maxDifficultyRatio-1));
}
export function calculate(state:State){
 const s=state.settings;
 const list=state.games.filter(g=>g.type==='standalone').map(g=>{
  const p=state.preferences[g.id]||{};
  const merged={...g,...p};
  const rating=(p.personalRating===undefined?g.personalRating:p.personalRating)??g.rating??5;
  const ratingPoints=Math.max(0,Math.min(1,(rating-5)/4))*s.ratingWeight;
  const low=Math.max(0,s.lowThreshold-rating)*s.lowPenalty;
  const mean=merged.mean==null?0:merged.mean/5*s.meanWeight;
  const box=p.box==null?0:p.box/3*s.boxWeight;
  const bias=(p.thumb||0)*s.thumbWeight;
  return {...merged,p,rating,ratingPoints,low,meanPenalty:mean,boxPenalty:box,bias,priority:ratingPoints-low-mean-box+bias+(p.mustKeep?1000:0),overlap:0,similarity:0,alternative:''};
 });
 const groups=new Map<string,typeof list>();
 for(const g of list){if(!g.group)continue;const key=g.group+'|'+g.mode;const a=groups.get(key)||[];a.push(g);groups.set(key,a);}
 const representatives=new Set<string>();
 for(const a of groups.values()){
  if(a.length<2)continue;
  const remaining=[...a].sort((a,b)=>b.priority-a.priority||Number(b.id)-Number(a.id));
  while(remaining.length){
   const rep=remaining.shift()!;
   // Compare each peer directly with its representative. Do not allow a chain
   // of intermediate weights to join light and heavy games into one cluster.
   const peers=remaining.filter(g=>complexitySimilarity(g.complexity,rep.complexity)!=null);
   if(!peers.length)continue;
   if(s.preserve&&(rep.p.thumb||0)!==-1)representatives.add(rep.id);
   for(const g of peers){
   remaining.splice(remaining.indexOf(g),1);
   const duration=g.minutes&&rep.minutes?Math.min(g.minutes,rep.minutes)/Math.max(g.minutes,rep.minutes):0;
   const weight=complexitySimilarity(g.complexity,rep.complexity)!;
   const players=g.minPlayers&&g.maxPlayers&&rep.minPlayers&&rep.maxPlayers?Math.max(0,Math.min(g.maxPlayers,rep.maxPlayers)-Math.max(g.minPlayers,rep.minPlayers)+1)/(Math.max(g.maxPlayers,rep.maxPlayers)-Math.min(g.minPlayers,rep.minPlayers)+1):0;
   g.similarity=Math.min(1,.4+(g.theme&&g.theme===rep.theme?.15:0)+.2*duration+.15*weight+.1*players);
   g.overlap=s.overlapWeight*Math.max(0,(g.similarity-.55)/.45);g.alternative=rep.id;
   }
  }
 }
 const ranked=list.map(g=>({...g,protected:!!g.p.mustKeep||representatives.has(g.id),representative:representatives.has(g.id),score:g.ratingPoints-g.low-g.meanPenalty-g.boxPenalty+g.bias-g.overlap})).sort((a,b)=>Number(b.protected)-Number(a.protected)||b.score-a.score||Number(a.id)-Number(b.id));
 const protectedCount=ranked.filter(g=>g.protected).length;
 const keepCount=Math.min(ranked.length,Math.max(s.target,protectedCount));
 const kept=new Set(ranked.slice(0,keepCount).map(g=>g.id));
 const cull=ranked.slice(keepCount).reverse();
 return {ranked,cull,kept,keepCount,protectedCount};
}
export type Scored=ReturnType<typeof calculate>['ranked'][number];
export function reason(g:Scored){return g.p.mustKeep?'Must keep':g.representative?'Group representative':g.p.thumb===-1?'Your thumbs down':g.low>0?'Below rating threshold':g.overlap>0?'Similar game retained':g.meanPenalty>0?'Mean interaction':g.boxPenalty>0?'Larger box':'Overall keep score';}
export function cullExplanation(g:Scored,state:State,result:ReturnType<typeof calculate>){
 const factors:{weight:number;clause:string}[]=[];
 const ratingSource=g.personalRating==null?'its BGG rating':'your rating';
 const ratingGap=Math.max(0,state.settings.ratingWeight-g.ratingPoints)+g.low;
 if(ratingGap>0)factors.push({weight:ratingGap,clause:g.low>0?`${ratingSource} of ${g.rating.toFixed(1)}/10 is below your ${state.settings.lowThreshold.toFixed(1)} threshold`:`${ratingSource} of ${g.rating.toFixed(1)}/10 earns fewer rating points`});
 if(g.bias<0)factors.push({weight:-g.bias,clause:'you gave it a thumbs down'});
 const alternative=result.ranked.find(other=>other.id===g.alternative);
 if(g.overlap>0&&alternative)factors.push({weight:g.overlap,clause:result.kept.has(alternative.id)?`you’re keeping “${alternative.name}”, which offers a similar play experience`:`its play experience overlaps with “${alternative.name}”, which is also a cull candidate`});
 if(g.meanPenalty>0)factors.push({weight:g.meanPenalty,clause:`its draft meanness rating of ${g.mean}/5 lowers its keep score`});
 if(g.boxPenalty>0)factors.push({weight:g.boxPenalty,clause:`its ${['small','standard','large','oversized'][g.p.box!]} box adds a shelf-space penalty`});
 const main=factors.sort((a,b)=>b.weight-a.weight).slice(0,2).map(f=>f.clause);
 if(!main.length)return `It falls below the keep cutoff at your current target of ${state.settings.target} games.`;
 return `It falls below the keep cutoff mainly because ${main.join(' and ')}.`;
}
export function parseCSV(text:string){
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw new Error('CSV contains an unclosed quoted field.');
 row.push(cell);if(row.some(Boolean))rows.push(row);
 const headers=rows.shift()?.map(x=>x.replace(/^\uFEFF/,'').trim().toLowerCase())||[];
 return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||''])));
}
export function collectionFromCSV(text:string,previous:Game[]){
 const rows=parseCSV(text);if(!rows.length||!('objectid' in rows[0])||!('objectname' in rows[0]))throw new Error('Upload a BGG collection CSV with objectid and objectname columns.');
 const old=new Map(previous.map(g=>[g.id,g]));const num=(v:string)=>Number(v)||null;
 const games:Game[]=rows.filter(r=>r.own==='1').map(r=>{const prior=old.get(r.objectid);return {id:r.objectid,name:r.objectname,type:r.itemtype==='expansion'?'expansion':'standalone',rating:num(r.average),personalRating:num(r.rating),complexity:num(r.avgweight),minutes:prior?.minutes??num(r.maxplaytime),minPlayers:num(r.minplayers),maxPlayers:num(r.maxplayers),bestPlayers:r.bggbestplayers,mean:prior?.mean??null,group:prior?.group||'',theme:prior?.theme||'',mode:prior?.mode||'',notes:prior?.notes||'',parentId:prior?.parentId||'',parentName:prior?.parentName||''};});
 if(!games.length)throw new Error('No owned games found in this CSV.');if(new Set(games.map(g=>g.id)).size!==games.length)throw new Error('Duplicate BGG IDs found. Export one entry per game.');return games;
}
