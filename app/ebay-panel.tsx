'use client';
import {useState} from 'react';
import {Download,RefreshCw,Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Sheet,SheetContent,SheetDescription,SheetHeader,SheetTitle} from '@/components/ui/sheet';
import {TITLE_MAX,UNDERCUT,defaultTitle,draftsCsv,undercutPrice,type EbayDraft} from '@/lib/ebay-drafts';
import type {ListingCopy,ListingFacts} from '@/lib/listing';
import {CONDITIONS,DEFAULT_CONDITION,complexitySimilarity,type Condition,type Scored} from '@/lib/model';
import type {PriceQuote} from '@/lib/prices';

type Draft={title:string;price:string;condition:Condition;description:string;notes:string;source:ListingCopy['source'];year?:string};
type Props={open:boolean;onOpenChange:(open:boolean)=>void;cull:Scored[];all:Scored[];prices:Record<string,PriceQuote>;profile:string|null};

const BATCH=5;
const range=(a:number|null,b:number|null)=>a&&b?(a===b?`${a}`:`${a}–${b}`):null;

/** Games from your collection that play alike: the app's own overlap groups. */
function similarTo(g:Scored,all:Scored[]){
 const alt=all.find(o=>o.id===g.alternative);
 const peers=all.filter(o=>o.id!==g.id&&o.id!==alt?.id&&g.group&&o.group===g.group&&o.mode===g.mode&&complexitySimilarity(o.complexity,g.complexity)!=null).sort((a,b)=>b.rating-a.rating);
 return [...(alt?[alt]:[]),...peers].slice(0,3).map(o=>o.name);
}

/** The market estimate that matches a copy's condition: new for sealed copies, used otherwise. */
const marketFor=(q:PriceQuote|undefined,condition:Condition)=>condition==='New'?q?.new:q?.used;

/** Suggested price: 10% under that market estimate. */
function priceFor(q:PriceQuote|undefined,condition:Condition){
 const e=marketFor(q,condition);
 return e?undercutPrice(e.median).toFixed(2):'';
}

function priceHint(q:PriceQuote|undefined,condition:Condition){
 const e=marketFor(q,condition);
 if(!e)return 'No market estimate yet. Use Check prices on the cull list to get a suggested price.';
 return `Suggested $${undercutPrice(e.median).toFixed(2)}: ${Math.round(UNDERCUT*100)}% under the $${e.median.toFixed(2)} ${condition==='New'?'new':'used'} market estimate.`;
}

function factsList(g:Scored,d:Draft){
 const players=range(g.minPlayers,g.maxPlayers);
 return [
  players&&`Players: ${players}${g.bestPlayers?` (best with ${g.bestPlayers.replace(/,/g,', ')})`:''}`,
  g.minutes&&`Play time: about ${g.minutes} minutes`,
  g.complexity&&`Complexity: ${g.complexity.toFixed(2)} / 5 (BoardGameGeek weight)`,
  g.publisher&&`Publisher: ${g.publisher}`,
  d.year&&`Published: ${d.year}`,
 ].filter((f):f is string=>!!f);
}

export function EbayPanel({open,onOpenChange,cull,all,prices,profile}:Props){
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [drafts,setDrafts]=useState<Record<string,Draft>>({});
 const [busy,setBusy]=useState('');
 const [message,setMessage]=useState('');
 const chosen=cull.filter(g=>selected.has(g.id));
 const unwritten=chosen.filter(g=>!drafts[g.id]);
 const ready=chosen.filter(g=>drafts[g.id]);

 const toggle=(id:string,on:boolean)=>setSelected(s=>{const n=new Set(s);if(on)n.add(id);else n.delete(id);return n;});
 const edit=(id:string,patch:Partial<Draft>)=>setDrafts(d=>({...d,[id]:{...d[id],...patch}}));

 async function write(games:Scored[]){
  setMessage('');
  let done=0,ai=true,warning='';
  try{
   for(let i=0;i<games.length;i+=BATCH){
    const batch=games.slice(i,i+BATCH);
    setBusy(`Writing ${Math.min(done+batch.length,games.length)} of ${games.length}…`);
    const facts:ListingFacts[]=batch.map(g=>({id:g.id,name:g.name,publisher:g.publisher||'',minPlayers:g.minPlayers,maxPlayers:g.maxPlayers,bestPlayers:g.bestPlayers,minutes:g.minutes,complexity:g.complexity,similar:similarTo(g,all),condition:drafts[g.id]?.condition??g.p.condition??DEFAULT_CONDITION}));
    const r=await fetch('/api/ebay/descriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({games:facts})});
    const j=await r.json() as {copies:Record<string,ListingCopy>;ai:boolean;warning?:string;error?:string};
    if(!r.ok)throw new Error(j.error||'Couldn’t write descriptions.');
    ai&&=j.ai;warning||=j.warning||'';
    setDrafts(d=>{const next={...d};for(const g of batch){const c=j.copies[g.id];if(!c)continue;const prev=d[g.id];const condition=prev?.condition??g.p.condition??DEFAULT_CONDITION;
     next[g.id]={title:prev?.title??defaultTitle(g.name,g.publisher||''),price:prev?.price??priceFor(prices[g.id],condition),condition,notes:prev?.notes??'',description:`${c.intro}\n\n${c.appeal}`.trim(),source:c.source,year:c.year};}return next;});
    done+=batch.length;
   }
   setMessage([warning,ai?'':'Descriptions use the built-in template. Set OPENAI_API_KEY on the server for AI-written copy.'].filter(Boolean).join(' '));
  }catch(e){setMessage(e instanceof Error?e.message:'Couldn’t write descriptions.');}
  finally{setBusy('');}
 }

 function download(){
  const rows:EbayDraft[]=ready.map(g=>{const d=drafts[g.id];const price=Number(d.price);return {id:g.id,name:g.name,title:d.title,price:Number.isFinite(price)&&price>0?price:null,condition:d.condition,description:d.description,notes:d.notes,facts:factsList(g,d)};});
  const url=URL.createObjectURL(new Blob([draftsCsv(rows)],{type:'text/csv'}));
  const a=document.createElement('a');a.href=url;a.download=`ebay-drafts-${profile??'collection'}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  setMessage(`Downloaded ${rows.length} draft${rows.length===1?'':'s'}. Upload it in eBay Seller Hub → Reports → Uploads, then add photos and shipping to each draft before listing.`);
 }

 return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="ebay-sheet"><SheetHeader><SheetTitle>Sell on eBay</SheetTitle><SheetDescription>Choose games from the cull list, write their listings, then download a file that creates eBay drafts.</SheetDescription></SheetHeader>
  <section className="ebay-step"><div className="ebay-step-head"><h3>1. Choose games</h3><span><Button variant="ghost" onClick={()=>setSelected(new Set(cull.map(g=>g.id)))}>Select all</Button><Button variant="ghost" onClick={()=>setSelected(new Set())} disabled={!selected.size}>Clear</Button></span></div>
   <ul className="ebay-pick">{cull.map(g=>{const used=prices[g.id]?.used;return <li key={g.id}><label className="check-label"><Checkbox checked={selected.has(g.id)} onCheckedChange={v=>toggle(g.id,v===true)} aria-label={`Sell ${g.name}`}/>{g.name}</label><span className="ebay-pick-meta">{[used&&`~$${Math.round(used.median)} used`,drafts[g.id]&&'written'].filter(Boolean).join(' · ')}</span></li>;})}</ul>
   <Button onClick={()=>void write(unwritten)} disabled={!unwritten.length||!!busy}><Sparkles className={busy?'animate-pulse':''}/>{busy||`Write descriptions${unwritten.length?` (${unwritten.length})`:''}`}</Button>
  </section>
  {message&&<p className="ebay-message" role="status">{message}</p>}
  {ready.length>0&&<section className="ebay-step"><h3>2. Review listings</h3>{ready.map(g=>{const d=drafts[g.id];return <article key={g.id} className="ebay-draft"><header><strong>{g.name}</strong><span className={`ebay-source ${d.source}`}>{d.source==='ai'?'AI-written':'Template'}</span><Button variant="ghost" onClick={()=>void write([g])} disabled={!!busy} aria-label={`Rewrite description for ${g.name}`}><RefreshCw/>Rewrite</Button></header>
    <label>Title <span className="ebay-count">{d.title.length}/{TITLE_MAX}</span><Input value={d.title} maxLength={TITLE_MAX} onChange={e=>edit(g.id,{title:e.target.value})}/></label>
    <div className="ebay-row"><label>Price (USD)<Input type="number" min={0} step="0.01" value={d.price} placeholder="Set a price" onChange={e=>edit(g.id,{price:e.target.value})}/></label>
     {/* Follow the new condition's suggestion unless the seller typed their own price. */}
     <label>Condition<Select value={d.condition} onValueChange={v=>edit(g.id,{condition:v as Condition,price:!d.price||d.price===priceFor(prices[g.id],d.condition)?priceFor(prices[g.id],v as Condition):d.price})}><SelectTrigger aria-label={`eBay condition for ${g.name}`}><SelectValue/></SelectTrigger><SelectContent>{CONDITIONS.map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></label></div>
    <p className="hint ebay-price-hint">{priceHint(prices[g.id],d.condition)}</p>
    <label>Description<Textarea rows={7} value={d.description} onChange={e=>edit(g.id,{description:e.target.value})}/></label>
    <label>Condition notes for buyers<Textarea rows={2} value={d.notes} placeholder="e.g. All components present, cards sleeved, light shelf wear on the box." onChange={e=>edit(g.id,{notes:e.target.value})}/></label>
    <p className="hint">The listing also includes player count, play time, complexity, publisher, year and a condition statement.</p>
   </article>;})}</section>}
  <footer className="ebay-footer"><Button onClick={download} disabled={!ready.length||!!busy}><Download/>Download eBay drafts{ready.length?` (${ready.length})`:''}</Button><p className="hint">eBay Seller Hub → Reports → Uploads → Upload template. Listings arrive as drafts; add photos and shipping before publishing.</p></footer>
 </SheetContent></Sheet>;
}
