import {XMLParser} from 'fast-xml-parser';
import {decodeEntities} from './text';
import type {Game} from './model';

// BGG XML API2. Since 2025 every request needs a registered application token:
// https://boardgamegeek.com/applications
// BGG_API_BASE lets browser tests point at a local fake BGG.
const apiBase=()=>process.env.BGG_API_BASE||'https://boardgamegeek.com/xmlapi2';
export const THING_BATCH=20;
export const REQUEST_GAP_MS=2000;

export class BggError extends Error{}

// Repeating elements always parse as arrays, even when there's only one. Forum
// lists are matched by path, since <forum> and <thread> are also root elements.
const LISTS=['item','link','name','result','poll-summary','error','listing','comment','rank'];
const LIST_PATHS=['forums.forum','forum.threads.thread','thread.articles.article'];
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',parseTagValue:false,isArray:(name,path,_leaf,isAttribute)=>!isAttribute&&(LISTS.includes(name)||LIST_PATHS.includes(String(path)))});
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null;};
const text=(v:unknown):string=>typeof v==='object'&&v!==null?String((v as Record<string,unknown>)['#text']??''):String(v??'');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node=any;

export async function bggXml(path:string):Promise<Node>{
 const token=process.env.BGG_API_TOKEN;
 if(!token)throw new BggError('BGG import is not configured. Set BGG_API_TOKEN on the server.');
 for(let attempt=0;attempt<10;attempt++){
  const r=await fetch(`${apiBase()}/${path}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  // 202 means BGG queued the collection export; 429/5xx are rate limits or hiccups. Both clear on retry.
  if(r.status===202||r.status===429||r.status>=500){await sleep(r.status===202?3000:5000);continue;}
  if(r.status===401||r.status===403)throw new BggError('BoardGameGeek rejected the API token.');
  if(!r.ok)throw new BggError(`BoardGameGeek returned an error (${r.status}).`);
  const doc=parser.parse(await r.text());
  const message=doc.errors?.error?.[0]?.message??doc.items?.error?.[0]?.message;
  if(message)throw new BggError(/invalid username/i.test(text(message))?'BoardGameGeek doesn’t recognise that username.':`BoardGameGeek: ${text(message)}`);
  return doc;
 }
 throw new BggError('BoardGameGeek is still preparing this collection. Try again in a minute.');
}

function bestPlayers(item:Node):string|undefined{
 const summary=(item['poll-summary']||[]).find((s:Node)=>s.name==='suggested_numplayers');
 const best=(summary?.result||[]).find((r:Node)=>r.name==='bestwith')?.value as string|undefined;
 if(!best)return undefined;
 const counts=new Set<number>();
 for(const part of best.replace(/^Best with/i,'').replace(/players?/i,'').split(',')){
  const [a,b]=part.split(/[–-]/).map(s=>parseInt(s,10));
  if(Number.isInteger(a))for(let n=a;n<=(Number.isInteger(b)?b:a)&&n<=100;n++)counts.add(n);
 }
 return counts.size?[...counts].join(','):undefined;
}

const NON_THEME=new Set(['Card Game','Dice','Party Game','Expansion for Base-game','Educational','Print & Play','Collectible Components','Bluffing','Deduction','Memory','Word Game','Trivia','Puzzle','Real-time','Math','Number',"Children's Game",'Action / Dexterity','Negotiation','Territory Building','Miniatures','Book','Video Game Theme','Movies / TV / Radio theme','Comic Book / Strip']);

function details(item:Node){
 const links:Node[]=item.link||[];
 const values=(type:string)=>links.filter(l=>l.type===type).map(l=>String(l.value));
 const mechanics=values('boardgamemechanic'),maxPlayers=num(item.maxplayers?.value);
 return {
  complexity:num(item.statistics?.ratings?.averageweight?.value),
  minutes:num(item.playingtime?.value),
  minPlayers:num(item.minplayers?.value),
  maxPlayers,
  bestPlayers:bestPlayers(item),
  mode:mechanics.includes('Cooperative Game')?'Cooperative':mechanics.includes('Team-Based Game')?'Teams':maxPlayers===1?'Solo':'Competitive',
  theme:values('boardgamecategory').find(c=>!NON_THEME.has(c))||'',
  publisher:values('boardgamepublisher').find(p=>p!=='(Unknown)')||'',
  parents:links.filter(l=>l.type==='boardgameexpansion'&&l.inbound==='true').map(l=>({id:String(l.id),name:String(l.value)})),
  categories:values('boardgamecategory'),
  mechanics,
 };
}
export type ThingDetails=ReturnType<typeof details>;

/** BGG game details (categories, mechanics, weight…) for any games, 20 per request. */
export async function fetchThingDetails(ids:string[]):Promise<Map<string,ThingDetails>>{
 const out=new Map<string,ThingDetails>();
 for(let i=0;i<ids.length;i+=THING_BATCH){
  if(i)await sleep(REQUEST_GAP_MS);
  const doc=await bggXml(`thing?id=${ids.slice(i,i+THING_BATCH).join(',')}&stats=1`);
  for(const item of doc.items?.item||[])out.set(String(item.id),details(item));
 }
 return out;
}

/** Owned games for a BGG user, keeping hand-edited fields from `previous` by BGG ID. */
export async function fetchBggCollection(username:string,previous:Game[]):Promise<Game[]>{
 const user=encodeURIComponent(username);
 const standalone=await bggXml(`collection?username=${user}&own=1&stats=1&excludesubtype=boardgameexpansion`);
 await sleep(REQUEST_GAP_MS);
 const expansions=await bggXml(`collection?username=${user}&own=1&stats=1&subtype=boardgameexpansion`);
 const owned=new Map<string,{name:string;type:Game['type'];stats:Node}>();
 for(const [doc,type] of [[standalone,'standalone'],[expansions,'expansion']] as const)
  for(const item of doc.items?.item||[])if(!owned.has(String(item.objectid)))owned.set(String(item.objectid),{name:decodeEntities(text(item.name?.[0])),type,stats:item.stats});
 if(!owned.size)throw new BggError(`No owned games found in ${username}’s BGG collection.`);
 if(owned.size>1000)throw new BggError('Collections over 1,000 games aren’t supported.');

 const ids=[...owned.keys()],things=new Map<string,ReturnType<typeof details>>();
 for(let i=0;i<ids.length;i+=THING_BATCH){
  await sleep(REQUEST_GAP_MS);
  const doc=await bggXml(`thing?id=${ids.slice(i,i+THING_BATCH).join(',')}&stats=1`);
  for(const item of doc.items?.item||[])things.set(String(item.id),details(item));
 }

 const old=new Map(previous.map(g=>[g.id,g]));
 return ids.map(id=>{
  const {name,type,stats}=owned.get(id)!,t=things.get(id),prior=old.get(id);
  const parent=type==='expansion'?t?.parents.find(p=>owned.has(p.id))||t?.parents[0]:undefined;
  return {id,name,type,
   rating:num(stats?.rating?.average?.value),personalRating:num(stats?.rating?.value),
   complexity:t?.complexity??null,minutes:prior?.minutes??t?.minutes??num(stats?.playingtime),
   minPlayers:t?.minPlayers??num(stats?.minplayers),maxPlayers:t?.maxPlayers??num(stats?.maxplayers),bestPlayers:t?.bestPlayers,
   mean:prior?.mean??null,group:prior?.group||'',theme:prior?.theme||t?.theme||'',mode:prior?.mode||t?.mode||'',notes:prior?.notes||'',
   parentId:parent?.id||prior?.parentId||'',parentName:parent?.name||prior?.parentName||'',publisher:t?.publisher||prior?.publisher||''};
 });
}
