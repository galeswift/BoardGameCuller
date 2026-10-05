import {getUser,sameOrigin} from '../../auth';
import {getDb} from '@/db';
import {BggError} from '@/lib/bgg';
import {QUOTE_VERSION,quotePrices,type PriceQuote} from '@/lib/prices';
export const dynamic='force-dynamic';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const STALE_MS=14*24*3600*1000;
// Prices are per game, not per profile, so the cache is shared.
// mode: 'cached' reads the cache only; 'missing' looks up absent or stale games; 'refresh' looks up all.
export async function POST(request:Request){
 const user=await getUser();if(!user)return json({error:'Sign in to check prices.'},401);
 if(!sameOrigin(request))return json({error:'Request origin does not match.'},403);
 let games:{id:string;name:string}[],mode:string;
 try{
  const body=await request.json();mode=body?.mode;games=body?.games;
  if(!['cached','missing','refresh'].includes(mode)||!Array.isArray(games)||games.length>1000||!games.every(g=>typeof g?.id==='string'&&/^\d{1,10}$/.test(g.id)&&typeof g.name==='string'&&g.name.length<=300))throw new Error();
 }catch{return json({error:'Invalid request.'},400);}
 try{
  const db=await getDb(),ids=games.map(g=>g.id);
  const rows=(await db.query<{game_id:string;quote:PriceQuote;checked:string}>('SELECT game_id,quote,checked FROM prices WHERE game_id=ANY($1)',[ids])).rows;
  // Quotes saved in an older format are treated as missing.
  const current=rows.filter(r=>r.quote?.v===QUOTE_VERSION);
  const prices:Record<string,PriceQuote>=Object.fromEntries(current.map(r=>[r.game_id,r.quote]));
  let sources:string[]=[],warnings:string[]=[];
  if(mode!=='cached'){
   const fresh=new Set(current.filter(r=>Date.now()-Date.parse(r.checked)<STALE_MS).map(r=>r.game_id));
   const todo=mode==='refresh'?games:games.filter(g=>!fresh.has(g.id));
   if(todo.length){
    // BoardGamePrices.com asks callers to identify their site.
    const host=request.headers.get('x-forwarded-host')||request.headers.get('host');
    const sitename=process.env.SITE_URL||`${request.headers.get('x-forwarded-proto')||'https'}://${host}`;
    const result=await quotePrices(todo,{sitename});
    ({sources,warnings}=result);
    // Don't cache empty quotes when every source failed.
    if(!sources.length)return json({error:`No price source could be reached. ${warnings.join(' ')}`.trim()},502);
    const quotes=result.quotes;
    for(const [id,quote] of Object.entries(quotes)){
     prices[id]=quote;
     await db.query('INSERT INTO prices(game_id,quote,checked) VALUES($1,$2::jsonb,$3) ON CONFLICT(game_id) DO UPDATE SET quote=excluded.quote,checked=excluded.checked',[id,JSON.stringify(quote),quote.checkedAt]);
    }
   }
  }
  return json({prices,sources,warnings});
 }catch(e){if(e instanceof BggError)return json({error:e.message},502);console.error('Price lookup failed',e);return json({error:'Price lookup failed. Please retry.'},503);}
}
