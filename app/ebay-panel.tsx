'use client';
import { useState } from 'react';
import { Download, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TITLE_MAX, UNDERCUT, defaultTitle, draftsCsv, undercutPrice, type EbayDraft } from '@/lib/ebay-drafts';
import type { ListingCopy, ListingFacts } from '@/lib/listing';
import { CONDITIONS, DEFAULT_CONDITION, complexitySimilarity, type Condition, type Scored } from '@/lib/model';
import type { PriceQuote } from '@/lib/prices';

type Draft = {
    title: string;
    price: string;
    condition: Condition;
    description: string;
    notes: string;
    source: ListingCopy['source'];
    year?: string;
};

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    cull: Scored[];
    all: Scored[];
    prices: Record<string, PriceQuote>;
    profile: string | null;
};

// Each game can take ~10s of paced BGG requests for reviews, so batches stay small.
const BATCH = 3;
const range = (a: number | null, b: number | null) => (a && b ? (a === b ? `${a}` : `${a}–${b}`) : null);

/** Games from your collection that play alike: the app's own overlap groups. */
function similarTo(game: Scored, all: Scored[])
{
    const alt = all.find(other => other.id === game.alternative);
    const peers = all
        .filter(
            other =>
                other.id !== game.id &&
                other.id !== alt?.id &&
                game.group &&
                other.group === game.group &&
                other.mode === game.mode &&
                complexitySimilarity(other.complexity, game.complexity) != null
        )
        .sort((a, b) => b.rating - a.rating);

    return [...(alt ? [alt] : []), ...peers].slice(0, 3).map(peer => peer.name);
}

/** The market estimate that matches a copy's condition: new for sealed copies, used otherwise. */
const marketFor = (quote: PriceQuote | undefined, condition: Condition) => (condition === 'New' ? quote?.new : quote?.used);

/** Suggested price: 10% under that market estimate. */
function priceFor(quote: PriceQuote | undefined, condition: Condition)
{
    const estimate = marketFor(quote, condition);

    return estimate ? undercutPrice(estimate.median).toFixed(2) : '';
}

function priceHint(quote: PriceQuote | undefined, condition: Condition)
{
    const estimate = marketFor(quote, condition);

    if (!estimate)
    {
        return 'No market estimate yet. Use Check prices on the cull list to get a suggested price.';
    }

    return `Suggested $${undercutPrice(estimate.median).toFixed(2)}: ${Math.round(UNDERCUT * 100)}% under the $${estimate.median.toFixed(2)} ${condition === 'New' ? 'new' : 'used'} market estimate.`;
}

function factsList(game: Scored, draft: Draft)
{
    const players = range(game.minPlayers, game.maxPlayers);

    return [
        players && `Players: ${players}${game.bestPlayers ? ` (best with ${game.bestPlayers.replace(/,/g, ', ')})` : ''}`,
        game.minutes && `Play time: about ${game.minutes} minutes`,
        game.complexity && `Complexity: ${game.complexity.toFixed(2)} / 5 (BoardGameGeek weight)`,
        game.publisher && `Publisher: ${game.publisher}`,
        draft.year && `Published: ${draft.year}`,
    ].filter((fact): fact is string => !!fact);
}

export function EbayPanel({ open, onOpenChange, cull, all, prices, profile }: Props)
{
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const chosen = cull.filter(game => selected.has(game.id));
    const unwritten = chosen.filter(game => !drafts[game.id]);
    const ready = chosen.filter(game => drafts[game.id]);

    const toggle = (id: string, checked: boolean) =>
        setSelected(previous =>
        {
            const updated = new Set(previous);

            if (checked)
            {
                updated.add(id);
            }
            else
            {
                updated.delete(id);
            }

            return updated;
        });
    const edit = (id: string, patch: Partial<Draft>) => setDrafts(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }));

    async function write(games: Scored[])
    {
        setMessage('');
        let done = 0;
        let ai = true;
        let warning = '';

        try
        {
            for (let index = 0; index < games.length; index += BATCH)
            {
                const batch = games.slice(index, index + BATCH);

                setBusy(`Writing ${Math.min(done + batch.length, games.length)} of ${games.length}…`);
                const facts: ListingFacts[] = batch.map(game => ({
                    id: game.id,
                    name: game.name,
                    publisher: game.publisher || '',
                    minPlayers: game.minPlayers,
                    maxPlayers: game.maxPlayers,
                    bestPlayers: game.bestPlayers,
                    minutes: game.minutes,
                    complexity: game.complexity,
                    similar: similarTo(game, all),
                    condition: drafts[game.id]?.condition ?? game.preference.condition ?? DEFAULT_CONDITION,
                }));
                const response = await fetch('/api/ebay/descriptions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ games: facts }),
                });
                const data = (await response.json()) as {
                    copies: Record<string, ListingCopy>;
                    ai: boolean;
                    warning?: string;
                    error?: string;
                };

                if (!response.ok)
                {
                    throw new Error(data.error || 'Couldn’t write descriptions.');
                }

                ai &&= data.ai;
                warning ||= data.warning || '';
                setDrafts(previous =>
                {
                    const next = { ...previous };

                    for (const game of batch)
                    {
                        const copy = data.copies[game.id];

                        if (!copy)
                        {
                            continue;
                        }

                        const prev = previous[game.id];
                        const condition = prev?.condition ?? game.preference.condition ?? DEFAULT_CONDITION;

                        next[game.id] = {
                            title: prev?.title ?? defaultTitle(game.name, game.publisher || ''),
                            price: prev?.price ?? priceFor(prices[game.id], condition),
                            condition,
                            notes: prev?.notes ?? '',
                            description: `${copy.intro}\n\n${copy.appeal}`.trim(),
                            source: copy.source,
                            year: copy.year,
                        };
                    }

                    return next;
                });
                done += batch.length;
            }

            setMessage(
                [warning, ai ? '' : 'Descriptions use the built-in template. Set OPENAI_API_KEY on the server for AI-written copy.']
                    .filter(Boolean)
                    .join(' ')
            );
        }
        catch (error)
        {
            setMessage(error instanceof Error ? error.message : 'Couldn’t write descriptions.');
        }
        finally
        {
            setBusy('');
        }
    }

    function download()
    {
        const rows: EbayDraft[] = ready.map(game =>
        {
            const draft = drafts[game.id];
            const price = Number(draft.price);

            return {
                id: game.id,
                name: game.name,
                title: draft.title,
                price: Number.isFinite(price) && price > 0 ? price : null,
                condition: draft.condition,
                description: draft.description,
                notes: draft.notes,
                facts: factsList(game, draft),
            };
        });
        const url = URL.createObjectURL(new Blob([draftsCsv(rows)], { type: 'text/csv' }));
        const link = document.createElement('a');

        link.href = url;
        link.download = `ebay-drafts-${profile ?? 'collection'}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(
            `Downloaded ${rows.length} draft${rows.length === 1 ? '' : 's'}. Upload it in eBay Seller Hub → Reports → Uploads, then add photos and shipping to each draft before listing.`
        );
    }

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="ebay-sheet">
                <SheetHeader>
                    <SheetTitle>Sell on eBay</SheetTitle>
                    <SheetDescription>
                        Choose games from the cull list, write their listings, then download a file that creates eBay drafts.
                    </SheetDescription>
                </SheetHeader>
                <section className="ebay-step">
                    <div className="ebay-step-head">
                        <h3>1. Choose games</h3>
                        <span>
                            <Button variant="ghost" onClick={() => setSelected(new Set(cull.map(game => game.id)))}>
                                Select all
                            </Button>
                            <Button variant="ghost" onClick={() => setSelected(new Set())} disabled={!selected.size}>
                                Clear
                            </Button>
                        </span>
                    </div>
                    <ul className="ebay-pick">
                        {cull.map(game =>
                        {
                            const used = prices[game.id]?.used;

                            return (
                                <li key={game.id}>
                                    <label className="check-label">
                                        <Checkbox
                                            checked={selected.has(game.id)}
                                            onCheckedChange={checked => toggle(game.id, checked === true)}
                                            aria-label={`Sell ${game.name}`}
                                        />
                                        {game.name}
                                    </label>
                                    <span className="ebay-pick-meta">
                                        {[used && `~$${Math.round(used.median)} used`, drafts[game.id] && 'written']
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    <Button onClick={() => void write(unwritten)} disabled={!unwritten.length || !!busy}>
                        <Sparkles className={busy ? 'animate-pulse' : ''} />
                        {busy || `Write descriptions${unwritten.length ? ` (${unwritten.length})` : ''}`}
                    </Button>
                </section>
                {message && (
                    <p className="ebay-message" role="status">
                        {message}
                    </p>
                )}
                {ready.length > 0 && (
                    <section className="ebay-step">
                        <h3>2. Review listings</h3>
                        {ready.map(game =>
                        {
                            const draft = drafts[game.id];

                            return (
                                <article key={game.id} className="ebay-draft">
                                    <header>
                                        <strong>{game.name}</strong>
                                        <span className={`ebay-source ${draft.source}`}>
                                            {draft.source === 'ai' ? 'AI-written' : 'Template'}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            onClick={() => void write([game])}
                                            disabled={!!busy}
                                            aria-label={`Rewrite description for ${game.name}`}
                                        >
                                            <RefreshCw />
                                            Rewrite
                                        </Button>
                                    </header>
                                    <label>
                                        Title{' '}
                                        <span className="ebay-count">
                                            {draft.title.length}/{TITLE_MAX}
                                        </span>
                                        <Input
                                            value={draft.title}
                                            maxLength={TITLE_MAX}
                                            onChange={event => edit(game.id, { title: event.target.value })}
                                        />
                                    </label>
                                    <div className="ebay-row">
                                        <label>
                                            Price (USD)
                                            <Input
                                                type="number"
                                                min={0}
                                                step="0.01"
                                                value={draft.price}
                                                placeholder="Set a price"
                                                onChange={event => edit(game.id, { price: event.target.value })}
                                            />
                                        </label>
                                        {/* Follow the new condition's suggestion unless the seller typed their own price. */}
                                        <label>
                                            Condition
                                            <Select
                                                value={draft.condition}
                                                onValueChange={condition =>
                                                    edit(game.id, {
                                                        condition: condition as Condition,
                                                        price:
                                                            !draft.price || draft.price === priceFor(prices[game.id], draft.condition)
                                                                ? priceFor(prices[game.id], condition as Condition)
                                                                : draft.price,
                                                    })
                                                }
                                            >
                                                <SelectTrigger aria-label={`eBay condition for ${game.name}`}>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {CONDITIONS.map(condition => (
                                                        <SelectItem key={condition} value={condition}>
                                                            {condition}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </label>
                                    </div>
                                    <p className="hint ebay-price-hint">{priceHint(prices[game.id], draft.condition)}</p>
                                    <label>
                                        Description
                                        <Textarea
                                            rows={7}
                                            value={draft.description}
                                            onChange={event => edit(game.id, { description: event.target.value })}
                                        />
                                    </label>
                                    <label>
                                        Condition notes for buyers
                                        <Textarea
                                            rows={2}
                                            value={draft.notes}
                                            placeholder="e.g. All components present, cards sleeved, light shelf wear on the box."
                                            onChange={event => edit(game.id, { notes: event.target.value })}
                                        />
                                    </label>
                                    <p className="hint">
                                        The listing also includes player count, play time, complexity, publisher, year and a condition
                                        statement.
                                    </p>
                                </article>
                            );
                        })}
                    </section>
                )}
                <footer className="ebay-footer">
                    <Button onClick={download} disabled={!ready.length || !!busy}>
                        <Download />
                        Download eBay drafts{ready.length ? ` (${ready.length})` : ''}
                    </Button>
                    <p className="hint">
                        eBay Seller Hub → Reports → Uploads → Upload template. Listings arrive as drafts; add photos and shipping before
                        publishing.
                    </p>
                </footer>
            </SheetContent>
        </Sheet>
    );
}
