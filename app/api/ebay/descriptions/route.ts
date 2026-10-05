import {getUser,sameOrigin} from '../../../auth';
import {writeListings,type ListingFacts} from '@/lib/listing';
import {CONDITIONS} from '@/lib/model';
export const dynamic='force-dynamic';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const num=(v:unknown)=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=10000);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max;

function valid(g:unknown):g is ListingFacts{
 const f=g as ListingFacts;
 return !!f&&typeof f.id==='string'&&/^\d{1,10}$/.test(f.id)&&text(f.name,300)&&text(f.publisher,300)
  &&num(f.minPlayers)&&num(f.maxPlayers)&&num(f.minutes)&&num(f.complexity)
  &&(f.bestPlayers===undefined||text(f.bestPlayers,100))&&Array.isArray(f.similar)&&f.similar.length<=5&&f.similar.every(s=>text(s,300))
  &&CONDITIONS.includes(f.condition);
}

// Writes listing copy for up to 10 games per request; the page sends batches.
export async function POST(request:Request){
 const user=await getUser();if(!user)return json({error:'Sign in to write listings.'},401);
 if(!sameOrigin(request))return json({error:'Request origin does not match.'},403);
 let games:ListingFacts[];
 try{games=(await request.json())?.games;if(!Array.isArray(games)||!games.length||games.length>10||!games.every(valid))throw new Error();}
 catch{return json({error:'Invalid request.'},400);}
 try{return json(await writeListings(games));}
 catch(e){console.error('Listing copy failed',e);return json({error:'Couldn’t write descriptions. Please retry.'},503);}
}
