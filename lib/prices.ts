import {REQUEST_GAP_MS,THING_BATCH,bggXml,sleep,type Node} from './bgg';

// Estimated resale values. Sources, in order of preference:
//  1. BGG GeekMarket listings (thing?marketplace=1): matched exactly by BGG ID.
//  2. eBay Browse API active fixed-price listings, matched by title. Only used when
//     EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are set. eBay's sold-price data needs a
//     partner-only API, so both sources are asking prices, not completed sales.
// Prices are USD medians, which a single silly listing can't skew.

export type PriceSource='bgg'|'ebay';
export type PriceEstimate={median:number;low:number;high:number;count:number;source:PriceSource;since?:string;until?:string};
export type PriceQuote={used:PriceEstimate|null;new:PriceEstimate|null;checkedAt:string};
export type Listing={price:number;date?:number};
type Split={new:Listing[];used:Listing[]};

export const MIN_LISTINGS=3;
const RECENT_MS=3*365*24*3600*1000;
const BGG_USED=new Set(['likenew','verygood','good','acceptable']);

export function estimate(listings:Listing[],source:PriceSource):PriceEstimate|null{
 if(!listings.length)return null;
 const prices=listings.map(l=>l.price).sort((a,b)=>a-b),mid=prices.length>>1;
 const median=prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2;
 const dates=listings.map(l=>l.date).filter((d):d is number=>d!=null).sort((a,b)=>a-b);
 const day=(t:number)=>new Date(t).toISOString().slice(0,10);
 return {median:Math.round(median*100)/100,low:prices[0],high:prices.at(-1)!,count:prices.length,source,...(dates.length?{since:day(dates[0]),until:day(dates.at(-1)!)}:{})};
}

/** USD GeekMarket listings per game, split by new vs used. */
export async function fetchBggMarket(ids:string[]):Promise<Map<string,Split>>{
 const out=new Map<string,Split>();
 for(let i=0;i<ids.length;i+=THING_BATCH){
  if(i)await sleep(REQUEST_GAP_MS);
  const doc=await bggXml(`thing?id=${ids.slice(i,i+THING_BATCH).join(',')}&marketplace=1`);
  for(const item of doc.items?.item||[]){
   const split:Split={new:[],used:[]};
   for(const l of (item.marketplacelistings?.listing||[]) as Node[]){
    const price=Number(l.price?.value),condition=String(l.condition?.value||'');
    if(l.price?.currency!=='USD'||!(price>0))continue;
    const date=Date.parse(l.listdate?.value);
    const listing={price,...(Number.isFinite(date)?{date}:{})};
    if(condition==='new')split.new.push(listing);else if(BGG_USED.has(condition))split.used.push(listing);
   }
   out.set(String(item.id),split);
  }
 }
 return out;
}

let ebayToken:{value:string;expires:number}|null=null;
export const ebayConfigured=()=>!!(process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET);
export function resetEbayToken(){ebayToken=null;}

async function ebayAccessToken():Promise<string>{
 if(ebayToken&&ebayToken.expires>Date.now()+60_000)return ebayToken.value;
 const basic=Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
 const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',cache:'no-store'});
 if(!r.ok)throw new Error(`eBay sign-in failed (${r.status}).`);
 const j=await r.json() as {access_token:string;expires_in:number};
 ebayToken={value:j.access_token,expires:Date.now()+j.expires_in*1000};
 return ebayToken.value;
}

const words=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);
const STOP=new Set(['the','a','an','of','and','to','in','for','on']);
// Accessories and partial lots that would drag the median around.
const JUNK=/\b(sleeves?|insert|organi[sz]er|promos?|playmat|mat|lot|bundle|replacement|parts?|pieces?|expansion|upgrade|stickers?|coins?|tokens?|meeples?|minis|miniatures|dice|box only|empty|proxy|custom|3d printed|stl)\b/;

/** Whether an eBay listing title is plausibly the base game itself. */
export function titleMatches(listingTitle:string,gameName:string){
 const listing=new Set(words(listingTitle)),name=words(gameName);
 if(!name.filter(w=>!STOP.has(w)).every(w=>listing.has(w)))return false;
 const junk=listingTitle.toLowerCase().match(JUNK);
 return !junk||words(gameName).join(' ').includes(junk[0]);
}

const EBAY_CONDITIONS={new:'1000',used:'1500|2750|3000|4000|5000|6000'};

export async function fetchEbay(gameName:string,condition:'new'|'used'):Promise<Listing[]>{
 const params=new URLSearchParams({q:`${gameName} board game`,limit:'50',filter:`buyingOptions:{FIXED_PRICE},priceCurrency:USD,conditionIds:{${EBAY_CONDITIONS[condition]}}`});
 const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,{headers:{Authorization:`Bearer ${await ebayAccessToken()}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'},cache:'no-store'});
 if(!r.ok)throw new Error(`eBay search failed (${r.status}).`);
 const j=await r.json() as {itemSummaries?:{title:string;price?:{value:string;currency:string}}[]};
 return (j.itemSummaries||[]).filter(i=>i.price?.currency==='USD'&&titleMatches(i.title,gameName)).map(i=>({price:Number(i.price!.value)})).filter(l=>l.price>0);
}

/** First estimate with enough listings, else the best-supported thin one. */
export function choose(...candidates:(PriceEstimate|null)[]):PriceEstimate|null{
 const present=candidates.filter((c):c is PriceEstimate=>!!c);
 return present.find(c=>c.count>=MIN_LISTINGS)??present.sort((a,b)=>b.count-a.count)[0]??null;
}

export async function quotePrices(games:{id:string;name:string}[],now=Date.now()):Promise<Record<string,PriceQuote>>{
 const market=await fetchBggMarket(games.map(g=>g.id));
 const checkedAt=new Date(now).toISOString(),out:Record<string,PriceQuote>={};
 for(const g of games){
  const split=market.get(g.id)??{new:[],used:[]};
  const quote={checkedAt} as PriceQuote;
  for(const condition of ['used','new'] as const){
   const all=split[condition],recent=all.filter(l=>l.date==null||now-l.date<=RECENT_MS);
   const bggRecent=estimate(recent,'bgg');
   let ebay:PriceEstimate|null=null;
   if((bggRecent?.count??0)<MIN_LISTINGS&&ebayConfigured()){
    try{ebay=estimate(await fetchEbay(g.name,condition),'ebay');}catch(e){console.error('eBay price lookup failed',g.name,e);}
   }
   quote[condition]=choose(bggRecent,ebay,estimate(all,'bgg'));
  }
  out[g.id]=quote;
 }
 return out;
}
