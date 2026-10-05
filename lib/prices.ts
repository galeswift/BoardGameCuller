import {REQUEST_GAP_MS,THING_BATCH,bggXml,sleep,type Node} from './bgg';

// Estimated resale values from up to three sources:
//  - BGG GeekMarket listings (thing?marketplace=1): used + new, matched by BGG ID.
//  - eBay Browse API active fixed-price listings: used + new, matched by title.
//    Only when EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are set.
//  - BoardGamePrices.com store prices: new (retail) only, matched by BGG ID.
//    Their terms: cache for at least an hour and link back where shown.
// Each source gives a USD median; the estimate averages the sources that have
// enough listings. Shipping is kept separate from the item price.
// All of these are asking prices, not completed sales.

export type PriceSource='bgg'|'ebay'|'bgp';
export type SourceEstimate={source:PriceSource;median:number;low:number;high:number;count:number;since?:string;until?:string;shipping?:number;url?:string};
export type PriceEstimate={median:number;low:number;high:number;count:number;shipping?:number;sources:SourceEstimate[]};
export const QUOTE_VERSION=2;
export type PriceQuote={v:typeof QUOTE_VERSION;used:PriceEstimate|null;new:PriceEstimate|null;checkedAt:string};
export type Listing={price:number;date?:number;shipping?:number};
type Split={new:Listing[];used:Listing[]};

export const MIN_LISTINGS=3;
const RECENT_MS=3*365*24*3600*1000;
const BGG_USED=new Set(['likenew','verygood','good','acceptable']);
const round=(n:number)=>Math.round(n*100)/100;

const medianOf=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b),mid=s.length>>1;return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;};

export function estimate(listings:Listing[],source:PriceSource,url?:string):SourceEstimate|null{
 if(!listings.length)return null;
 const prices=listings.map(l=>l.price).sort((a,b)=>a-b);
 const dates=listings.map(l=>l.date).filter((d):d is number=>d!=null).sort((a,b)=>a-b);
 const shipping=listings.map(l=>l.shipping).filter((s):s is number=>s!=null);
 const day=(t:number)=>new Date(t).toISOString().slice(0,10);
 return {source,median:round(medianOf(prices)),low:prices[0],high:prices.at(-1)!,count:prices.length,
  ...(dates.length?{since:day(dates[0]),until:day(dates.at(-1)!)}:{}),
  ...(shipping.length?{shipping:round(medianOf(shipping))}:{}),...(url?{url}:{})};
}

/** Averages the sources with enough listings; if none have enough, averages them all. */
export function combine(...candidates:(SourceEstimate|null)[]):PriceEstimate|null{
 const present=candidates.filter((c):c is SourceEstimate=>!!c);
 if(!present.length)return null;
 const strong=present.filter(c=>c.count>=MIN_LISTINGS),use=strong.length?strong:present;
 const shipping=use.map(s=>s.shipping).filter((s):s is number=>s!=null);
 return {median:round(use.reduce((t,s)=>t+s.median,0)/use.length),low:Math.min(...use.map(s=>s.low)),high:Math.max(...use.map(s=>s.high)),
  count:use.reduce((t,s)=>t+s.count,0),...(shipping.length?{shipping:round(shipping.reduce((a,b)=>a+b,0)/shipping.length)}:{}),sources:use};
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

const bgpBase=()=>process.env.BGP_API_BASE||'https://boardgameprices.com';
const BGP_BATCH=20;

/** In-stock US store prices per game from BoardGamePrices.com. */
export async function fetchBgp(ids:string[],sitename:string):Promise<Map<string,{listings:Listing[];url:string}>>{
 const out=new Map<string,{listings:Listing[];url:string}>();
 for(let i=0;i<ids.length;i+=BGP_BATCH){
  if(i)await sleep(1000);
  const params=new URLSearchParams({eid:ids.slice(i,i+BGP_BATCH).join(','),sitename,currency:'USD',destination:'US'});
  const r=await fetch(`${bgpBase()}/api/info?${params}`,{cache:'no-store'});
  if(!r.ok)throw new Error(`BoardGamePrices.com returned ${r.status}.`);
  const j=await r.json() as {currency?:string;items?:{external_id?:string;url?:string;prices?:{product?:number|string;shipping?:number|string;shipping_known?:boolean;stock?:string}[]}[]};
  if(j.currency&&j.currency!=='USD')continue;
  for(const item of j.items||[]){
   if(!item.external_id)continue;
   const listings=(item.prices||[]).filter(p=>p.stock==='Y').map(p=>{const shipping=Number(p.shipping);return {price:Number(p.product),...(p.shipping_known&&Number.isFinite(shipping)?{shipping}:{})};}).filter(l=>l.price>0);
   out.set(String(item.external_id),{listings,url:item.url||''});
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
 type Money={value:string;currency:string};
 const j=await r.json() as {itemSummaries?:{title:string;price?:Money;shippingOptions?:{shippingCostType?:string;shippingCost?:Money}[]}[]};
 return (j.itemSummaries||[]).filter(i=>i.price?.currency==='USD'&&titleMatches(i.title,gameName)).map(i=>{
  const ship=i.shippingOptions?.find(o=>o.shippingCost?.currency==='USD');
  const shipping=ship?Number(ship.shippingCost!.value):NaN;
  return {price:Number(i.price!.value),...(Number.isFinite(shipping)?{shipping}:{})};
 }).filter(l=>l.price>0);
}

/** Runs `fn` over items with at most `limit` in flight. */
async function eachLimit<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>){
 let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length)await fn(items[next++]);}));
}

export type QuoteResult={quotes:Record<string,PriceQuote>;sources:PriceSource[];warnings:string[]};

export async function quotePrices(games:{id:string;name:string}[],{sitename,now=Date.now()}:{sitename:string;now?:number}):Promise<QuoteResult>{
 const ids=games.map(g=>g.id),warnings:string[]=[],sources:PriceSource[]=[];
 const [market,bgp]=await Promise.all([
  fetchBggMarket(ids).then(m=>{sources.push('bgg');return m;}).catch(e=>{console.error('BGG prices failed',e);warnings.push(`BGG GeekMarket unavailable: ${e instanceof Error?e.message:e}`);return new Map<string,Split>();}),
  fetchBgp(ids,sitename).then(m=>{sources.push('bgp');return m;}).catch(e=>{console.error('BoardGamePrices.com failed',e);warnings.push('BoardGamePrices.com unavailable.');return new Map<string,{listings:Listing[];url:string}>();}),
 ]);
 const ebay=new Map<string,{new:SourceEstimate|null;used:SourceEstimate|null}>();
 if(ebayConfigured()){
  sources.push('ebay');
  let failed=false;
  await eachLimit(games,4,async g=>{
   const one=async(c:'new'|'used')=>{try{return estimate(await fetchEbay(g.name,c),'ebay');}catch(e){console.error('eBay price lookup failed',g.name,e);failed=true;return null;}};
   ebay.set(g.id,{used:await one('used'),new:await one('new')});
  });
  if(failed)warnings.push('Some eBay lookups failed.');
 }
 const checkedAt=new Date(now).toISOString(),quotes:Record<string,PriceQuote>={};
 for(const g of games){
  const split=market.get(g.id)??{new:[],used:[]};
  const bgg=(c:'new'|'used')=>{const all=split[c],recent=estimate(all.filter(l=>l.date==null||now-l.date<=RECENT_MS),'bgg');return recent&&recent.count>=MIN_LISTINGS?recent:estimate(all,'bgg');};
  const store=bgp.get(g.id);
  quotes[g.id]={v:QUOTE_VERSION,checkedAt,
   used:combine(bgg('used'),ebay.get(g.id)?.used??null),
   new:combine(bgg('new'),ebay.get(g.id)?.new??null,store?estimate(store.listings,'bgp',store.url):null)};
 }
 return {quotes,sources,warnings};
}
