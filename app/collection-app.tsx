'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DEFAULT_SORT, SORTS, describeSort, nextSort, sortGames, type Sort, type SortKey } from '@/lib/sort';
import {
    ThumbsUp,
    ThumbsDown,
    Search,
    Download,
    Upload,
    LockKeyhole,
    Box,
    SlidersHorizontal,
    Undo2,
    ChevronRight,
    Check,
    RefreshCw,
    Library,
    Info,
    CircleDollarSign,
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    Crown,
    FileSpreadsheet,
    Store,
    Pencil,
    Star,
    TrendingDown,
    Layers,
    Swords,
    Scissors,
    type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { NKG_TEMPLATE_PATH, fillTradeInTemplate } from '@/lib/nkg';
import { EbayPanel } from './ebay-panel';
import { CoveragePanel, CoverageSummary } from './coverage-panel';
import { coverage } from '@/lib/coverage';
import type { PriceEstimate, PriceQuote, PriceSource, SourceEstimate } from '@/lib/prices';
import { Progress } from '@/components/ui/progress';
import { GROUP_BATCH } from '@/lib/groups';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
    CONDITIONS,
    DEFAULT_CONDITION,
    bggImageUrl,
    calculate,
    collectionFromCSV,
    cullExplanation,
    cullReasons,
    defaults,
    keepFactors,
    nameKey,
    type Condition,
    type Factor,
    type FactorKind,
    type State,
    type Game,
    type Preference,
    type Settings,
    type Scored,
} from '@/lib/model';

type Operation = { payload: unknown; resolve: () => void; reject: (error: Error) => void };
const boxLabels = ['Small', 'Standard', 'Large', 'Oversized'];

function Choice({
    value,
    onChange,
    disabled = false,
    label,
}: {
    value: string;
    onChange: (newValue: string) => void;
    disabled?: boolean;
    label: string;
})
{
    return (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger aria-label={label} className="box-select">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="unknown">Size unknown</SelectItem>
                {boxLabels.map((boxLabel, index) => (
                    <SelectItem key={boxLabel} value={String(index)}>
                        {boxLabel}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

const factorIcons: Record<FactorKind, LucideIcon> = {
    mustKeep: LockKeyhole,
    representative: Crown,
    thumbUp: ThumbsUp,
    thumbDown: ThumbsDown,
    rating: Star,
    lowRating: TrendingDown,
    overlap: Layers,
    mean: Swords,
    box: Box,
    cutoff: Scissors,
};

/** The game's box art, faded in behind the start of its row like a small hero image. */
function RowArt({ url }: { url?: string })
{
    const safeUrl = bggImageUrl(url);

    if (!safeUrl)
    {
        return null;
    }

    return <span className="row-art" style={{ backgroundImage: `url("${safeUrl}")` }} aria-hidden="true" />;
}

// One chip per scoring factor; hover or focus for the details.
function FactorChips({ factors, onOpen }: { factors: Factor[]; onOpen: (id: string) => void })
{
    return (
        <div className="factors">
            {factors.map(factor =>
            {
                const Icon = factorIcons[factor.kind];

                return (
                    <Tooltip key={factor.kind}>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                className="factor"
                                data-kind={factor.kind}
                                aria-label={`${factor.title}. ${factor.lines.join(' ')}`}
                                onClick={factor.alternativeId ? () => onOpen(factor.alternativeId!) : undefined}
                            >
                                <Icon size={15} aria-hidden />
                                {factor.badge && <span>{factor.badge}</span>}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="factor-tip" side="top">
                            <strong>{factor.title}</strong>
                            {factor.lines.map(line => (
                                <span key={line}>{line}</span>
                            ))}
                        </TooltipContent>
                    </Tooltip>
                );
            })}
        </div>
    );
}

const usd = (amount: number) => '$' + Math.round(amount);
const month = (isoDate: string) =>
    new Date(isoDate + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
// Prices are looked up a batch at a time so the page can show progress.
const PRICE_BATCH = 10;
const PRICE_STALE_MS = 14 * 24 * 3600 * 1000;
const SOURCE_NAMES: Record<PriceSource, string> = { bgg: 'BGG GeekMarket', bgp: 'BoardGamePrices.com' };

/** One line of the tooltip per price source, e.g. "BGG GeekMarket: $25 median of 3 listings ($20–$30)". */
function describeSource(source: SourceEstimate)
{
    const kind = source.source === 'bgp' ? 'store price' : 'listing';
    const plural = source.count === 1 ? '' : 's';
    const shipping = source.shipping != null ? `, shipping ~${usd(source.shipping)}` : '';
    const listed = source.since ? `, listed ${month(source.since)} – ${month(source.until!)}` : '';

    return `${SOURCE_NAMES[source.source]}: ${usd(source.median)} median of ${source.count} ${kind}${plural} (${usd(source.low)}–${usd(source.high)})${shipping}${listed}`;
}

function PriceLine({ label, estimate, checkedAt }: { label: 'Used' | 'New'; estimate: PriceEstimate | null; checkedAt: string })
{
    const lines = estimate
        ? [
            ...estimate.sources.map(describeSource),
            ...(estimate.sources.length > 1 ? [`Average of ${estimate.sources.length} sources.`] : []),
            estimate.shipping != null ? `Shipping is extra: typically ~${usd(estimate.shipping)}.` : 'Shipping is not included.',
            'Asking prices in USD, not completed sales.',
        ]
        : ['No USD listings found.'];

    lines.push(`Checked ${new Date(checkedAt).toLocaleDateString()}`);

    // Store prices link back to BoardGamePrices.com, as their terms ask.
    const storeUrl = estimate?.sources.find(source => source.source === 'bgp' && source.url)?.url;

    if (storeUrl)
    {
        lines.push('Click to see store prices on BoardGamePrices.com.');
    }

    const priceText = estimate ? usd(estimate.median) : 'unknown';

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={`price-line${storeUrl ? ' linked' : ''}`}
                    aria-label={`${label} value ${priceText}. ${lines.join(' ')}`}
                    onClick={storeUrl ? () => window.open(storeUrl, '_blank', 'noopener') : undefined}
                >
                    <span>{label}</span>
                    <strong className={estimate ? undefined : 'none'}>{estimate ? usd(estimate.median) : '—'}</strong>
                </button>
            </TooltipTrigger>
            <TooltipContent className="factor-tip" side="top">
                <strong>
                    {label} ≈ {priceText}
                    {estimate?.shipping != null ? ` + ~${usd(estimate.shipping)} shipping` : ''}
                </strong>
                {lines.map(line => (
                    <span key={line}>{line}</span>
                ))}
            </TooltipContent>
        </Tooltip>
    );
}

function PriceCell({ quote }: { quote?: PriceQuote })
{
    return (
        <div className="price-value">
            {quote ? (
                <>
                    <PriceLine label="Used" estimate={quote.used} checkedAt={quote.checkedAt} />
                    <PriceLine label="New" estimate={quote.new} checkedAt={quote.checkedAt} />
                </>
            ) : (
                <span className="price-missing" title="Not checked yet">
                    —
                </span>
            )}
        </div>
    );
}

function ConditionChoice({ value, onChange, label }: { value: Condition; onChange: (newValue: Condition) => void; label: string })
{
    return (
        <Select value={value} onValueChange={choice => onChange(choice as Condition)}>
            <SelectTrigger aria-label={label} className="box-select condition-select">
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
    );
}

function download(name: string, value: string | Uint8Array<ArrayBuffer>, type = 'application/json')
{
    const url = URL.createObjectURL(new Blob([value], { type }));
    const link = document.createElement('a');

    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CollectionApp()
{
    const [state, setState] = useState<State | null>(null);
    const [view, setView] = useState('preferences');
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const [loadError, setLoadError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [pending, setPending] = useState(0);
    const [loaded, setLoaded] = useState(false);
    const [quick, setQuick] = useState(false);
    const [detail, setDetail] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [undo, setUndo] = useState<{ id: string; p: Preference; name: string } | null>(null);
    const [profile, setProfile] = useState<string | null>(null);
    const [profiles, setProfiles] = useState<string[]>([]);
    const [adding, setAdding] = useState(false);
    const [newProfile, setNewProfile] = useState('');
    const [syncing, setSyncing] = useState(false);
    const [prices, setPrices] = useState<Record<string, PriceQuote>>({});
    const [pricing, setPricing] = useState(false);
    const [ebayOpen, setEbayOpen] = useState(false);
    const [priceProgress, setPriceProgress] = useState<{ done: number; total: number } | null>(null);
    const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
    const [mainProfile, setMainProfile] = useState<string | null>(null);
    const [removing, setRemoving] = useState(false);
    const [aiAvailable, setAiAvailable] = useState(false);
    const [groupProgress, setGroupProgress] = useState<{ done: number; total: number } | null>(null);
    const [demo, setDemo] = useState(false);
    const queue = useRef<Operation[]>([]);
    const busy = useRef(false);
    const blocked = useRef(false);
    const stateRef = useRef(state);
    const uploadRef = useRef<HTMLInputElement>(null);
    const profileRef = useRef<string | null>(null);
    // True in the read-only demo, where changes stay in this tab.
    const demoRef = useRef(false);

    stateRef.current = state;
    const load = useCallback(async (next?: string) =>
    {
        setLoadError('');
        try
        {
            const want = next ?? profileRef.current ?? new URLSearchParams(location.search).get('profile');
            const response = await fetch('/api/state' + (want ? `?profile=${encodeURIComponent(want)}` : ''), { cache: 'no-store' });
            const data = (await response.json()) as State & {
                profile: string;
                defaultProfile: string;
                aiAvailable: boolean;
                demo?: boolean;
                profiles: string[];
                error?: string;
            };

            if (!response.ok)
            {
                throw new Error(data.error);
            }

            profileRef.current = data.profile;
            setProfile(data.profile);
            setMainProfile(data.defaultProfile);
            setAiAvailable(data.aiAvailable);
            demoRef.current = !!data.demo;
            setDemo(!!data.demo);
            setProfiles(data.profiles);
            setState({ games: data.games, preferences: data.preferences, settings: data.settings, savedAt: data.savedAt });
            setLoaded(true);
            const pageUrl = new URL(location.href);

            pageUrl.searchParams.set('profile', data.profile);
            history.replaceState(null, '', pageUrl);
        }
        catch (error)
        {
            setLoadError(error instanceof Error ? error.message : 'Loading failed.');
        }
    }, []);

    useEffect(() =>
    {
        void load();
    }, [load]);

    function switchProfile(name: string)
    {
        if (queue.current.length || syncing)
        {
            setNotice('Wait for pending changes to finish before switching collections.');

            return;
        }

        const profileName = name.trim().toLowerCase();

        if (!profileName)
        {
            return;
        }

        setAdding(false);
        setNewProfile('');
        setState(null);
        setLoaded(false);
        setUndo(null);
        setDetail(null);
        setNotice('');
        setQuick(false);
        void load(profileName);
    }

    const pump = useCallback(async () =>
    {
        if (busy.current || blocked.current)
        {
            return;
        }

        busy.current = true;
        try
        {
            while (queue.current.length)
            {
                const operation = queue.current[0];

                try
                {
                    const response = await fetch('/api/state', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(operation.payload),
                    });
                    const data = (await response.json()) as { savedAt: string; error?: string };

                    if (!response.ok)
                    {
                        throw new Error(data.error || 'Saving failed.');
                    }

                    queue.current.shift();
                    operation.resolve();
                    setState(prev => (prev ? { ...prev, savedAt: data.savedAt } : prev));
                    setPending(queue.current.length);
                    setSaveError('');
                }
                catch (error)
                {
                    blocked.current = true;
                    setSaveError(error instanceof Error ? error.message : 'Saving failed.');
                    break;
                }
            }
        }
        finally
        {
            busy.current = false;
        }
    }, []);
    const enqueue = useCallback(
        (data: object) =>
        {
            // The demo keeps changes in this tab only; the server wouldn't accept them anyway.
            if (demoRef.current)
            {
                return Promise.resolve();
            }

            const payload = { ...data, profile: profileRef.current };
            const promise = new Promise<void>((resolve, reject) => queue.current.push({ payload, resolve, reject }));

            setPending(queue.current.length);
            void pump();

            return promise;
        },
        [pump]
    );
    const change = useCallback(
        (id: string, patch: Preference, remember = true) =>
        {
            const current = stateRef.current;

            if (!current)
            {
                return Promise.reject(new Error('Collection is not loaded.'));
            }

            if (!current.games.some(game => game.id === id))
            {
                return Promise.reject(new Error('Game is not in this collection.'));
            }

            if (remember)
            {
                setUndo({ id, p: { ...current.preferences[id] }, name: current.games.find(game => game.id === id)!.name });
            }

            setState(prev =>
                prev ? { ...prev, preferences: { ...prev.preferences, [id]: { ...prev.preferences[id], ...patch } } } : prev
            );

            return enqueue({ action: 'preference', id, patch });
        },
        [enqueue]
    );

    function changeSettings(patch: Partial<Settings>)
    {
        setState(prev => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
        void enqueue({ action: 'settings', patch });
    }

    useEffect(() =>
    {
        const warn = (event: BeforeUnloadEvent) =>
        {
            if (queue.current.length)
            {
                event.preventDefault();
                event.returnValue = '';
            }
        };

        window.addEventListener('beforeunload', warn);

        return () => window.removeEventListener('beforeunload', warn);
    }, []);
    const result = useMemo(() => (state ? calculate(state) : null), [state]);
    const collectionCoverage = useMemo(() => (result ? coverage(result.ranked, result.kept) : null), [result]);
    const all = useMemo(() => (result ? [...result.ranked].sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name))) : []), [result]);
    const visible = useMemo(() =>
    {
        const base = view === 'cull' ? result?.cull || [] : view === 'ranking' ? result?.ranked || [] : sortGames(all, sort);

        return base.filter(
            game =>
                game.name.toLowerCase().includes(search.toLowerCase()) &&
                (filter === 'all' ||
                    (filter === 'unreviewed' && !game.preference.reviewed) ||
                    (filter === 'locked' && game.preference.mustKeep) ||
                    (filter === 'unknown' && (!game.group || game.mean == null)))
        );
    }, [view, result, all, filter, search, sort]);
    const cullKey = result?.cull.map(game => game.id).join(',') ?? '';

    useEffect(() =>
    {
        if (view !== 'cull' || !cullKey)
        {
            return;
        }

        let stale = false;

        void (async () =>
        {
            try
            {
                const response = await fetch('/api/prices', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'cached', games: cullKey.split(',').map(id => ({ id, name: '' })) }),
                });
                const data = (await response.json()) as { prices: Record<string, PriceQuote> };

                if (response.ok && !stale)
                {
                    setPrices(previous => ({ ...previous, ...data.prices }));
                }
            }
            catch
            {}
        })();

        return () =>
        {
            stale = true;
        };
    }, [view, cullKey]);
    const usesStorePrices = !!result?.cull.some(game => prices[game.id]?.new?.sources.some(estimate => estimate.source === 'bgp'));
    const pricesMissing = result ? result.cull.filter(game => !prices[game.id] || prices[game.id].due).length : 0;
    const reviewed = all.filter(game => game.preference.reviewed).length;
    const next = all.find(game => !game.preference.reviewed && game.name.toLowerCase().includes(search.toLowerCase()));

    useEffect(() =>
    {
        if (!quick || !next)
        {
            return;
        }

        const listener = (event: KeyboardEvent) =>
        {
            const target = event.target as HTMLElement;

            if (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.closest('[role="combobox"]'))
            {
                return;
            }

            if (['1', '2', '3'].includes(event.key))
            {
                event.preventDefault();
                void change(next.id, { thumb: event.key === '1' ? 1 : event.key === '3' ? -1 : 0, reviewed: true });
            }
        };

        window.addEventListener('keydown', listener);

        return () => window.removeEventListener('keydown', listener);
    }, [quick, next, change]);
    useEffect(() =>
    {
        const context = (
            document as unknown as { modelContext?: { registerTool: (value: unknown, options: unknown) => Promise<void> | void } }
        ).modelContext;

        if (!context?.registerTool)
        {
            return;
        }

        const lifecycle = new AbortController();
        const register = (tool: unknown) =>
        {
            try
            {
                void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() =>
                {});
            }
            catch
            {}
        };

        register({
            name: 'read_collection_cull',
            description: 'Read the current cull candidates, protected games and target.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: () =>
            {
                const latestState = stateRef.current;

                if (!latestState)
                {
                    throw new Error('Collection is not loaded.');
                }

                const latestResult = calculate(latestState);

                return {
                    target: latestState.settings.target,
                    cull: latestResult.cull.map(game => ({ id: game.id, name: game.name, score: game.score })),
                    protected: latestResult.ranked.filter(game => game.protected).map(game => ({ id: game.id, name: game.name })),
                };
            },
        });
        register({
            name: 'retain_collection_game',
            description: 'Set or clear Must keep for a collection game, save it, and update the visible cull list.',
            inputSchema: {
                type: 'object',
                properties: { gameId: { type: 'string' }, keep: { type: 'boolean' } },
                required: ['gameId', 'keep'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false },
            execute: async (input: unknown) =>
            {
                const toolInput = input as { gameId: string; keep: boolean };

                if (typeof toolInput?.gameId !== 'string' || typeof toolInput?.keep !== 'boolean')
                {
                    throw new Error('gameId and keep are required.');
                }

                await change(toolInput.gameId, { mustKeep: toolInput.keep });

                return { id: toolInput.gameId, mustKeep: toolInput.keep, cullCount: calculate(stateRef.current!).cull.length };
            },
        });

        return () => lifecycle.abort();
    }, [change]);

    function backup()
    {
        if (!state)
        {
            return;
        }

        download(
            'collection-cull-backup.json',
            JSON.stringify({ format: 'collection-cull-v1', ...state, exportedAt: new Date().toISOString() }, null, 2)
        );
        setNotice(pending ? 'Backup downloaded, including changes still waiting to save.' : 'Backup downloaded with all your preferences.');
    }

    async function importFile(file: File)
    {
        if (!state)
        {
            return;
        }

        if (queue.current.length)
        {
            setNotice('Wait for pending choices to save before importing.');

            return;
        }

        try
        {
            if (file.size > 1500000)
            {
                throw new Error('Choose a file smaller than 1.5 MB.');
            }

            const text = await file.text();

            if (file.name.toLowerCase().endsWith('.json'))
            {
                const restoredBackup = JSON.parse(text);

                if (restoredBackup.format !== 'collection-cull-v1' || !Array.isArray(restoredBackup.games))
                {
                    throw new Error('Choose a Collection Cull backup.');
                }

                await enqueue({ action: 'restore', backup: restoredBackup });
                await load();
                setNotice('Backup restored.');
            }
            else
            {
                const games = collectionFromCSV(text, state.games);

                await enqueue({ action: 'collection', games });
                setState(prev => (prev ? { ...prev, games } : prev));
                setNotice(`Updated ${games.length} collection entries. Preferences were matched by BGG ID.`);
            }
        }
        catch (error)
        {
            setNotice(error instanceof Error ? error.message : 'Import failed.');
        }
        finally
        {
            if (uploadRef.current)
            {
                uploadRef.current.value = '';
            }
        }
    }

    async function syncBgg()
    {
        const currentProfile = profileRef.current;

        if (!state || !currentProfile)
        {
            return;
        }

        if (queue.current.length)
        {
            setNotice('Wait for pending choices to save before importing.');

            return;
        }

        setSyncing(true);
        setNotice(`Importing ${currentProfile}’s collection from BoardGameGeek. This can take a minute…`);
        try
        {
            const response = await fetch('/api/bgg', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: currentProfile }),
            });
            const data = (await response.json()) as { games: Game[]; savedAt: string; error?: string };

            if (!response.ok)
            {
                throw new Error(data.error || 'BGG import failed.');
            }

            if (profileRef.current !== currentProfile)
            {
                return;
            }

            setState(prev => (prev ? { ...prev, games: data.games, savedAt: data.savedAt } : prev));
            setProfiles(list => (list.includes(currentProfile) ? list : [...list, currentProfile].sort()));
            setNotice(`Imported ${data.games.length} entries from BoardGameGeek. Preferences were matched by BGG ID.`);
            if (aiAvailable)
            {
                void assignPlayGroups(data.games);
            }
        }
        catch (error)
        {
            if (profileRef.current === currentProfile)
            {
                setNotice(error instanceof Error ? error.message : 'BGG import failed.');
            }
        }
        finally
        {
            setSyncing(false);
        }
    }

    const knownProfiles = profile && !profiles.includes(profile) ? [...profiles, profile].sort() : profiles;

    async function checkPrices()
    {
        if (!result)
        {
            return;
        }

        const games = result.cull.map(game => ({ id: game.id, name: game.name }));
        // Missing or out-of-date prices first; if everything is current, refresh the lot.
        const due = games.filter(game =>
        {
            const quote = prices[game.id];

            return !quote || quote.due || Date.now() - Date.parse(quote.checkedAt) > PRICE_STALE_MS;
        });
        const todo = due.length ? due : games;
        const sources = new Set<PriceSource>();
        const warnings = new Set<string>();

        setPricing(true);
        setNotice('');
        setPriceProgress({ done: 0, total: todo.length });
        try
        {
            for (let index = 0; index < todo.length; index += PRICE_BATCH)
            {
                const response = await fetch('/api/prices', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'refresh', games: todo.slice(index, index + PRICE_BATCH) }),
                });
                const data = (await response.json()) as {
                    prices: Record<string, PriceQuote>;
                    sources: PriceSource[];
                    warnings: string[];
                    error?: string;
                };

                if (!response.ok)
                {
                    throw new Error(data.error || 'Price lookup failed.');
                }

                setPrices(previous => ({ ...previous, ...data.prices }));
                data.sources.forEach(source => sources.add(source));
                data.warnings?.forEach(warning => warnings.add(warning));
                setPriceProgress({ done: Math.min(index + PRICE_BATCH, todo.length), total: todo.length });
            }

            setNotice(
                [
                    `Prices updated for ${todo.length} game${todo.length === 1 ? '' : 's'} from ${(
                        Object.keys(SOURCE_NAMES) as PriceSource[]
                    )
                        .filter(source => sources.has(source))
                        .map(source => SOURCE_NAMES[source])
                        .join(', ')}. Values are median asking prices in USD, excluding shipping.`,
                    ...warnings,
                ].join(' ')
            );
        }
        catch (error)
        {
            setNotice(`${error instanceof Error ? error.message : 'Price lookup failed.'} Prices found so far are kept.`);
        }
        finally
        {
            setPricing(false);
            setPriceProgress(null);
        }
    }

    // Standalone games with no play group, from the collection or from your own edits.
    const ungrouped = (games: Game[], prefs: Record<string, Preference>) =>
        games.filter(game => game.type === 'standalone' && !game.group && !prefs[game.id]?.group);

    async function assignPlayGroups(games: Game[])
    {
        const currentProfile = profileRef.current;
        const todo = ungrouped(games, stateRef.current?.preferences ?? {});

        if (!currentProfile || !todo.length || groupProgress)
        {
            return;
        }

        setGroupProgress({ done: 0, total: todo.length });
        let assigned = 0;

        try
        {
            for (let index = 0; index < todo.length; index += GROUP_BATCH)
            {
                const batch = todo.slice(index, index + GROUP_BATCH);
                const response = await fetch('/api/groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile: currentProfile, ids: batch.map(game => game.id) }),
                });
                const data = (await response.json()) as { groups?: Record<string, string>; error?: string };

                if (!response.ok)
                {
                    throw new Error(data.error || 'Couldn’t assign play groups.');
                }

                if (profileRef.current !== currentProfile)
                {
                    return;
                }

                const groups = data.groups ?? {};

                assigned += Object.keys(groups).length;
                setState(prev =>
                    prev
                        ? {
                            ...prev,
                            games: prev.games.map(game => (groups[game.id] && !game.group ? { ...game, group: groups[game.id] } : game)),
                        }
                        : prev
                );
                setGroupProgress({ done: Math.min(index + GROUP_BATCH, todo.length), total: todo.length });
            }

            setNotice(`Assigned play groups to ${assigned} games, so similar games now count as overlap. Edit any group with the pencil.`);
        }
        catch (error)
        {
            if (profileRef.current === currentProfile)
            {
                setNotice(`${error instanceof Error ? error.message : 'Couldn’t assign play groups.'} Groups assigned so far are kept.`);
            }
        }
        finally
        {
            setGroupProgress(null);
        }
    }

    async function removeProfile()
    {
        const currentProfile = profileRef.current;

        if (!currentProfile || currentProfile === mainProfile)
        {
            return;
        }

        if (queue.current.length)
        {
            setNotice('Wait for pending choices to save before removing a collection.');

            return;
        }

        try
        {
            const response = await fetch('/api/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remove', profile: currentProfile }),
            });
            const data = (await response.json()) as { error?: string };

            if (!response.ok)
            {
                throw new Error(data.error || 'Couldn’t remove the collection.');
            }

            setProfiles(list => list.filter(existing => existing !== currentProfile));
            switchProfile(mainProfile ?? '');
            setNotice(`Removed ${currentProfile}’s collection.`);
        }
        catch (error)
        {
            setNotice(error instanceof Error ? error.message : 'Couldn’t remove the collection.');
        }
    }

    async function exportTradeIn()
    {
        if (!result)
        {
            return;
        }

        try
        {
            const response = await fetch(NKG_TEMPLATE_PATH);

            if (!response.ok)
            {
                throw new Error('Template unavailable.');
            }

            const rows = [...result.cull]
                .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)))
                .map(game => ({
                    publisher: game.publisher || '',
                    title: game.name,
                    condition: game.preference.condition ?? DEFAULT_CONDITION,
                    comments: '',
                }));

            download(
                `noble-knight-trade-in-${profile ?? 'collection'}.xlsx`,
                fillTradeInTemplate(new Uint8Array(await response.arrayBuffer()), rows) as Uint8Array<ArrayBuffer>,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            setNotice(
                `Exported ${rows.length} games to Noble Knight’s trade-in template. Check conditions and add comments before sending.`
            );
        }
        catch
        {
            setNotice('Couldn’t build the trade-in spreadsheet. Please retry.');
        }
    }

    function undoLast()
    {
        if (!undo)
        {
            return;
        }

        const current = stateRef.current!.preferences[undo.id] || {};
        const old = undo.p;
        const game = stateRef.current!.games.find(candidate => candidate.id === undo.id)!;
        const restore: Preference = {};

        for (const key of Object.keys(current) as (keyof Preference)[])
        {
            (restore as Record<string, unknown>)[key] = Object.hasOwn(old, key)
                ? old[key]
                : key === 'thumb'
                    ? 0
                    : key === 'mustKeep' || key === 'reviewed'
                        ? false
                        : key === 'box'
                            ? null
                            : ((game as unknown as Record<string, unknown>)[key] ?? null);
        }

        void change(undo.id, { ...restore, ...old }, false);
        setNotice(`Restored the previous choice for ${undo.name}.`);
        setUndo(null);
    }

    const expansionGames = state?.games.filter(game => game.type === 'expansion') || [];
    const detailGame = state?.games.find(game => game.id === detail);
    const detailPref = detail ? state?.preferences[detail] || {} : {};

    function thumbControls(game: Scored | Game, preference: Preference)
    {
        return (
            <div className="thumbs" aria-label={`Preference for ${game.name}`}>
                <Button
                    variant="ghost"
                    aria-label={`Prefer keep ${game.name}`}
                    aria-pressed={preference.thumb === 1}
                    className={preference.thumb === 1 ? 'selected up' : 'up'}
                    onClick={() => void change(game.id, { thumb: 1, reviewed: true })}
                >
                    <ThumbsUp />
                </Button>
                <Button
                    variant="ghost"
                    aria-label={`Neutral ${game.name}`}
                    aria-pressed={(preference.thumb || 0) === 0 && !!preference.reviewed}
                    className={(preference.thumb || 0) === 0 && preference.reviewed ? 'selected' : 'neutral'}
                    onClick={() => void change(game.id, { thumb: 0, reviewed: true })}
                >
                    —
                </Button>
                <Button
                    variant="ghost"
                    aria-label={`Prefer cull ${game.name}`}
                    aria-pressed={preference.thumb === -1}
                    className={preference.thumb === -1 ? 'selected down' : 'down'}
                    onClick={() => void change(game.id, { thumb: -1, reviewed: true })}
                >
                    <ThumbsDown />
                </Button>
            </div>
        );
    }

    function saveStatus()
    {
        if (demo)
        {
            return 'Demo: changes aren’t saved';
        }

        if (saveError)
        {
            return 'Changes not saved';
        }

        if (pending)
        {
            return `Saving ${pending} ${pending === 1 ? 'change' : 'changes'}…`;
        }

        if (state?.savedAt)
        {
            return 'All changes saved';
        }

        return loaded ? 'Collection loaded' : 'Loading…';
    }

    return (
        <TooltipProvider delayDuration={150}>
            <div className="workspace">
                <header className="topbar">
                    <div className="brand">
                        <span className="brand-icon">
                            <Library size={23} />
                        </span>
                        <div>
                            <h1>Collection Cull</h1>
                            <span>{demo ? 'Sample collection' : profile ? `${profile}’s collection` : 'Loading…'}</span>
                        </div>
                    </div>
                    <div className="top-actions">
                        {demo ? null : adding ? (
                            <form
                                className="profile-form"
                                onSubmit={event =>
                                {
                                    event.preventDefault();
                                    switchProfile(newProfile);
                                }}
                            >
                                <Input
                                    placeholder="BGG username"
                                    aria-label="BGG username"
                                    value={newProfile}
                                    onChange={event => setNewProfile(event.target.value)}
                                    autoFocus
                                />
                                <Button type="submit" disabled={!newProfile.trim()}>
                                    Open
                                </Button>
                                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                                    Cancel
                                </Button>
                            </form>
                        ) : (
                            <Select
                                value={profile ?? ''}
                                onValueChange={selection =>
                                    selection === '__new'
                                        ? setAdding(true)
                                        : selection === '__remove'
                                            ? setRemoving(true)
                                            : switchProfile(selection)
                                }
                                disabled={pending > 0 || syncing}
                            >
                                <SelectTrigger aria-label="Whose collection" className="box-select">
                                    <SelectValue placeholder="Collection" />
                                </SelectTrigger>
                                <SelectContent>
                                    {knownProfiles.map(profileName => (
                                        <SelectItem key={profileName} value={profileName}>
                                            {profileName}
                                        </SelectItem>
                                    ))}
                                    <SelectItem value="__new">Another BGG user…</SelectItem>
                                    {profile && profile !== mainProfile && (
                                        <SelectItem value="__remove" className="remove-option">
                                            Remove {profile}’s collection…
                                        </SelectItem>
                                    )}
                                </SelectContent>
                            </Select>
                        )}
                        <AlertDialog open={removing} onOpenChange={setRemoving}>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Remove {profile}’s collection?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        This deletes its games, choices and settings from this app. Nothing changes on BoardGameGeek, and
                                        you can bring it back later with Another BGG user… and Sync from BGG.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction variant="destructive" onClick={() => void removeProfile()}>
                                        Remove collection
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                        <span className={`save-status ${saveError ? 'failed' : ''}`} role="status">
                            {saveStatus()}
                        </span>
                        {!demo && (
                            <Button variant="outline" onClick={() => void syncBgg()} disabled={!state || pending > 0 || syncing}>
                                <RefreshCw className={syncing ? 'animate-spin' : ''} />
                                {syncing ? 'Importing…' : 'Sync from BGG'}
                            </Button>
                        )}
                        <Button variant="outline" onClick={backup} disabled={!state}>
                            <Download />
                            Backup
                        </Button>
                        {!demo && (
                            <Button variant="outline" onClick={() => uploadRef.current?.click()} disabled={!state || pending > 0}>
                                <Upload />
                                Import
                            </Button>
                        )}
                        <input
                            ref={uploadRef}
                            type="file"
                            accept=".csv,.json"
                            hidden
                            onChange={event =>
                            {
                                const file = event.target.files?.[0];

                                if (file)
                                {
                                    void importFile(file);
                                }
                            }}
                        />
                    </div>
                </header>
                {demo && (
                    <div className="demo-banner" role="note">
                        <span>
                            You’re trying the demo with a sample collection. Change anything you like: nothing is saved, and reloading
                            starts fresh.
                        </span>
                        <a href="/login">Sign in</a>
                    </div>
                )}
                {loadError ? (
                    <section className="message error">
                        <h2>Couldn’t load your collection</h2>
                        <p>{loadError}</p>
                        <Button onClick={() => void load()}>
                            <RefreshCw />
                            Retry
                        </Button>
                        <a href="/login">Sign in</a>
                    </section>
                ) : !state || !result ? (
                    <section className="loading">Loading your collection…</section>
                ) : !state.games.length ? (
                    <section className="message">
                        <h2>No collection for {profile} yet</h2>
                        <p>
                            Import their owned games straight from BoardGameGeek, or use Import to load a BGG CSV export or a Collection
                            Cull backup.
                        </p>
                        {notice && <p role="status">{notice}</p>}
                        <Button onClick={() => void syncBgg()} disabled={syncing}>
                            <RefreshCw className={syncing ? 'animate-spin' : ''} />
                            {syncing ? 'Importing…' : 'Import from BoardGameGeek'}
                        </Button>
                    </section>
                ) : (
                    <>
                        {saveError && (
                            <div className="message error">
                                <strong>{saveError}</strong>
                                <p>Your choices remain on this page. Download a backup before closing if saving is unavailable.</p>
                                <Button
                                    onClick={() =>
                                    {
                                        blocked.current = false;
                                        setSaveError('');
                                        void pump();
                                    }}
                                >
                                    Retry saving
                                </Button>
                                <Button variant="outline" onClick={backup}>
                                    Download backup
                                </Button>
                            </div>
                        )}
                        <section className="overview">
                            <div className="target-block">
                                <span className="eyebrow">Make room on your shelves</span>
                                <label htmlFor="target">
                                    Keep{' '}
                                    <Input
                                        id="target"
                                        type="number"
                                        min={0}
                                        max={all.length}
                                        value={state.settings.target}
                                        onChange={event =>
                                        {
                                            const newTarget = Number(event.target.value);

                                            if (Number.isInteger(newTarget) && newTarget >= 0 && newTarget <= all.length)
                                            {
                                                changeSettings({ target: newTarget });
                                            }
                                        }}
                                    />{' '}
                                    standalone games
                                </label>
                                <p>
                                    {all.length} games · {expansionGames.length} expansions reviewed separately
                                </p>
                            </div>
                            <div className="counts">
                                <div>
                                    <strong>{result.cull.length}</strong>
                                    <span>Cull candidates</span>
                                </div>
                                <div>
                                    <strong>
                                        {reviewed}
                                        <small>/{all.length}</small>
                                    </strong>
                                    <span>Preferences reviewed</span>
                                </div>
                                <div>
                                    <strong>{all.filter(game => game.preference.mustKeep).length}</strong>
                                    <span>Must keep</span>
                                </div>
                            </div>
                            <div className="review-progress" aria-label={`${reviewed} of ${all.length} preferences reviewed`}>
                                <span style={{ width: `${(reviewed / all.length) * 100}%` }} />
                            </div>
                        </section>
                        {result.protectedCount > state.settings.target && (
                            <div className="message">
                                Your {result.protectedCount} protected games exceed the target. The cull list keeps every protected game.
                                Lower protections or raise the target.
                            </div>
                        )}
                        {notice && (
                            <div className="notice" role="status">
                                {notice}
                                <Button variant="ghost" onClick={() => setNotice('')} aria-label="Dismiss notice">
                                    Dismiss
                                </Button>
                            </div>
                        )}
                        {undo && (
                            <div className="undo-bar">
                                Last choice: {undo.name}
                                <Button variant="ghost" onClick={undoLast}>
                                    <Undo2 />
                                    Undo
                                </Button>
                            </div>
                        )}
                        <Tabs
                            value={view}
                            onValueChange={tab =>
                            {
                                setView(tab);
                                setQuick(false);
                                setFilter('all');
                            }}
                        >
                            <div className="view-bar">
                                <TabsList className="view-tabs">
                                    <TabsTrigger value="preferences">All Games</TabsTrigger>
                                    <TabsTrigger value="cull">
                                        Cull list <span>{result.cull.length}</span>
                                    </TabsTrigger>
                                    <TabsTrigger value="coverage">Coverage</TabsTrigger>
                                    <TabsTrigger value="ranking">Keep ranking</TabsTrigger>
                                    <TabsTrigger value="expansions">Expansions</TabsTrigger>
                                    <TabsTrigger value="settings">
                                        <SlidersHorizontal />
                                        Scoring
                                    </TabsTrigger>
                                </TabsList>
                            </div>
                        </Tabs>
                        {view === 'settings' ? (
                            <section className="settings">
                                <div>
                                    <h2>Keep score</h2>
                                    <p>
                                        Ratings lead the decision and overlap comes next. Box size adds a small shelf-space deduction. Mean
                                        interaction is off by default: raise its deduction to count it.
                                    </p>
                                    <div className="settings-grid">
                                        {(
                                            [
                                                ['ratingWeight', 'Rating points'],
                                                ['lowThreshold', 'Low rating threshold'],
                                                ['lowPenalty', 'Deduction per point below threshold'],
                                                ['overlapWeight', 'Maximum overlap deduction'],
                                                ['meanWeight', 'Maximum mean deduction'],
                                                ['boxWeight', 'Maximum box-size deduction'],
                                                ['thumbWeight', 'Thumb preference points'],
                                            ] as [keyof Settings, string][]
                                        ).map(([key, label]) => (
                                            <label key={key}>
                                                {label}
                                                <Input
                                                    type="number"
                                                    min={key === 'lowThreshold' ? 1 : 0}
                                                    max={key === 'lowThreshold' ? 10 : 200}
                                                    step="0.5"
                                                    value={Number(state.settings[key])}
                                                    onChange={event =>
                                                    {
                                                        const newValue = Number(event.target.value);

                                                        if (newValue >= 0 && newValue <= 200)
                                                        {
                                                            changeSettings({ [key]: newValue });
                                                        }
                                                    }}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                    <label className="check-label">
                                        <Checkbox
                                            checked={state.settings.preserve}
                                            onCheckedChange={checked => changeSettings({ preserve: checked === true })}
                                        />
                                        Preserve representatives for groups with similar complexity
                                    </label>
                                </div>
                                <aside className="method">
                                    <h3>How to read the shortlist</h3>
                                    <p>
                                        Your personal rating overrides the BGG average. Ratings earn up to 70 points between 5 and 9, with
                                        an additional deduction below 7.
                                    </p>
                                    <p>
                                        Games must share a play-experience group and mode, and have close BGG complexity weights, before
                                        overlap can lower their score. Complexity uses a logarithmic model: each weight point doubles a
                                        difficulty estimate. Pairs more than 50% apart in that estimate (about 0.58 weight points) cannot be
                                        alternatives, regardless of their other features. Missing complexity receives no overlap deduction.
                                    </p>
                                    <p>
                                        Within that limit, theme, duration, complexity and player range determine the overlap deduction.
                                        Ratings and your preferences choose separate representatives for lighter and heavier games.
                                        Complexity is a scoring model, not a calibrated measurement of difficulty.
                                    </p>
                                    <p>
                                        Must keep always retains a game. Thumbs express preference and can be outweighed by other factors.
                                    </p>
                                    <p>
                                        Box sizes: small 0, standard 1, large 2, oversized 3 points at the default setting. Unknown sizes
                                        receive no deduction.
                                    </p>
                                    <p>
                                        Groups and mean scores are draft judgments. Unknown classifications need review. The export has no
                                        useful play counts or rating vote counts.
                                    </p>
                                    <h3>Collection updates</h3>
                                    <p>
                                        Sync from BGG or import a fresh BGG CSV to update your games while preserving choices by BGG ID.
                                        Each BGG username keeps its own collection and choices. Import a JSON backup to restore saved
                                        choices.
                                    </p>
                                </aside>
                            </section>
                        ) : view === 'coverage' ? (
                            collectionCoverage && <CoveragePanel coverage={collectionCoverage} cullCount={result.cull.length} />
                        ) : (
                            <>
                                {view === 'cull' && collectionCoverage && result.cull.length > 0 && (
                                    <CoverageSummary
                                        coverage={collectionCoverage}
                                        cullCount={result.cull.length}
                                        onOpen={() => setView('coverage')}
                                    />
                                )}
                                <div className="list-toolbar">
                                    <div className="search-field">
                                        <Search size={19} />
                                        <Input
                                            placeholder="Find a game…"
                                            aria-label="Find a game"
                                            value={search}
                                            onChange={event => setSearch(event.target.value)}
                                        />
                                    </div>
                                    {view !== 'expansions' && (
                                        <Select value={filter} onValueChange={setFilter}>
                                            <SelectTrigger aria-label="Filter games">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="all">All games</SelectItem>
                                                <SelectItem value="unreviewed">Not yet reviewed</SelectItem>
                                                <SelectItem value="locked">Must keep</SelectItem>
                                                <SelectItem value="unknown">Classification needed</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    )}
                                    {view === 'preferences' && !quick && (
                                        <>
                                            <Select
                                                value={sort.key}
                                                onValueChange={selection =>
                                                    setSort({ key: selection as SortKey, dir: SORTS[selection as SortKey].dir })
                                                }
                                            >
                                                <SelectTrigger aria-label="Sort games by">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(Object.keys(SORTS) as SortKey[]).map(sortKey => (
                                                        <SelectItem key={sortKey} value={sortKey}>
                                                            Sort: {SORTS[sortKey].label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button
                                                variant="outline"
                                                onClick={() => setSort(current => ({ ...current, dir: current.dir === 1 ? -1 : 1 }))}
                                                aria-label={`Reverse sort order (now ${describeSort(sort)})`}
                                                title={describeSort(sort)}
                                            >
                                                <ArrowUpDown />
                                            </Button>
                                        </>
                                    )}
                                    {view === 'preferences' &&
                                        !quick &&
                                        aiAvailable &&
                                        ungrouped(state.games, state.preferences).length > 0 && (
                                        <Button
                                            variant="outline"
                                            onClick={() => void assignPlayGroups(state.games)}
                                            disabled={!!groupProgress || syncing}
                                        >
                                            <Layers />
                                            {groupProgress
                                                ? `Assigning ${groupProgress.done}/${groupProgress.total}…`
                                                : `Assign play groups (${ungrouped(state.games, state.preferences).length})`}
                                        </Button>
                                    )}
                                    {view === 'preferences' && (
                                        <Button className="quick-button" onClick={() => setQuick(!quick)}>
                                            {quick ? 'Back to list' : 'Quick review'}
                                            <ChevronRight />
                                        </Button>
                                    )}
                                    {view === 'cull' && (
                                        <Button
                                            variant="outline"
                                            onClick={() =>
                                            {
                                                const escape = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';

                                                download(
                                                    'cull-list.csv',
                                                    [
                                                        [
                                                            'BGG ID',
                                                            'Game',
                                                            'Keep score',
                                                            'Why it’s on the cull list',
                                                            'Alternative',
                                                            'Your thumb',
                                                            'Box size',
                                                            'Est. used (USD)',
                                                            'Est. new (USD)',
                                                            'Est. used shipping (USD)',
                                                            'Est. new shipping (USD)',
                                                        ],
                                                        ...result.cull.map(game => [
                                                            game.id,
                                                            game.name,
                                                            game.score.toFixed(2),
                                                            cullExplanation(game, state, result),
                                                            all.find(other => other.id === game.alternative)?.name || '',
                                                            game.preference.thumb === 1
                                                                ? 'Prefer keep'
                                                                : game.preference.thumb === -1
                                                                    ? 'Prefer cull'
                                                                    : 'Neutral',
                                                            game.preference.box == null ? 'Unknown' : boxLabels[game.preference.box],
                                                            prices[game.id]?.used?.median ?? '',
                                                            prices[game.id]?.new?.median ?? '',
                                                            prices[game.id]?.used?.shipping ?? '',
                                                            prices[game.id]?.new?.shipping ?? '',
                                                        ]),
                                                    ]
                                                        .map(row => row.map(escape).join(','))
                                                        .join('\r\n'),
                                                    'text/csv'
                                                );
                                            }}
                                        >
                                            <Download />
                                            Export cull list
                                        </Button>
                                    )}
                                    {view === 'cull' && (
                                        <Button variant="outline" onClick={() => void exportTradeIn()} disabled={!result.cull.length}>
                                            <FileSpreadsheet />
                                            Noble Knight trade-in
                                        </Button>
                                    )}
                                    {view === 'cull' && (
                                        <Button variant="outline" onClick={() => setEbayOpen(true)} disabled={!result.cull.length}>
                                            <Store />
                                            Sell on eBay
                                        </Button>
                                    )}
                                    {view === 'cull' && !demo && (
                                        <Button
                                            variant="outline"
                                            onClick={() => void checkPrices()}
                                            disabled={pricing || !result.cull.length}
                                        >
                                            <CircleDollarSign className={pricing ? 'animate-pulse' : ''} />
                                            {pricing
                                                ? priceProgress
                                                    ? `Checking ${priceProgress.done}/${priceProgress.total}…`
                                                    : 'Checking prices…'
                                                : pricesMissing
                                                    ? 'Check prices'
                                                    : 'Refresh prices'}
                                        </Button>
                                    )}
                                </div>
                                {groupProgress && (
                                    <div className="price-progress" role="status" aria-live="polite">
                                        <span>
                                            Assigning play groups… {groupProgress.done} of {groupProgress.total} games
                                        </span>
                                        <Progress
                                            value={(groupProgress.done / groupProgress.total) * 100}
                                            aria-label="Play group progress"
                                        />
                                    </div>
                                )}
                                {view === 'cull' && priceProgress && (
                                    <div className="price-progress" role="status" aria-live="polite">
                                        <span>
                                            Checking prices… {priceProgress.done} of {priceProgress.total} games
                                        </span>
                                        <Progress
                                            value={(priceProgress.done / priceProgress.total) * 100}
                                            aria-label="Price check progress"
                                        />
                                    </div>
                                )}
                                {quick ? (
                                    <section className="quick-review">
                                        {next ? (
                                            <>
                                                <span className="eyebrow">
                                                    {reviewed + 1} / {all.length} · next unreviewed game
                                                </span>
                                                <h2>{next.name}</h2>
                                                <p>
                                                    {next.group || 'Classification needed'} ·{' '}
                                                    {next.minutes ? `${next.minutes} min` : 'Time unknown'} · {next.minPlayers}–
                                                    {next.maxPlayers} players
                                                </p>
                                                <div className="quick-metrics">
                                                    <span>
                                                        <strong>{next.rating.toFixed(2)}</strong> rating
                                                    </span>
                                                    <span>
                                                        <strong>{next.complexity?.toFixed(1) || '?'}</strong> complexity
                                                    </span>
                                                    <span>
                                                        <strong>{next.mean ?? '?'}</strong> mean /5
                                                    </span>
                                                </div>
                                                <div className="quick-choices">
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => void change(next.id, { thumb: 1, reviewed: true })}
                                                    >
                                                        <ThumbsUp />
                                                        Prefer keep <kbd>1</kbd>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => void change(next.id, { thumb: 0, reviewed: true })}
                                                    >
                                                        Neutral <kbd>2</kbd>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={() => void change(next.id, { thumb: -1, reviewed: true })}
                                                    >
                                                        <ThumbsDown />
                                                        Prefer cull <kbd>3</kbd>
                                                    </Button>
                                                </div>
                                                <div className="quick-extra">
                                                    <label className="check-label">
                                                        <Checkbox
                                                            checked={!!next.preference.mustKeep}
                                                            onCheckedChange={checked =>
                                                                void change(next.id, { mustKeep: checked === true })
                                                            }
                                                        />
                                                        Must keep
                                                    </label>
                                                    <Choice
                                                        value={next.preference.box == null ? 'unknown' : String(next.preference.box)}
                                                        onChange={choice =>
                                                            void change(next.id, { box: choice === 'unknown' ? null : Number(choice) })
                                                        }
                                                        label={`Box size for ${next.name}`}
                                                    />
                                                    <Button variant="ghost" onClick={() => setDetail(next.id)}>
                                                        Edit details
                                                    </Button>
                                                </div>
                                                <p className="hint">Keys 1, 2 and 3 save a choice and move to the next game.</p>
                                            </>
                                        ) : (
                                            <>
                                                <Check className="complete-icon" />
                                                <h2>Every matching game reviewed</h2>
                                                <p>You can still change any choice in the list.</p>
                                                <Button variant="outline" onClick={() => setQuick(false)}>
                                                    Return to list
                                                </Button>
                                            </>
                                        )}
                                    </section>
                                ) : view === 'expansions' ? (
                                    <section className="game-list">
                                        {expansionGames
                                            .filter(game => game.name.toLowerCase().includes(search.toLowerCase()))
                                            .map(game =>
                                            {
                                                const preference = state.preferences[game.id] || {};
                                                const parentCull =
                                                    game.parentId &&
                                                    !result.kept.has(game.parentId) &&
                                                    all.some(other => other.id === game.parentId);

                                                return (
                                                    <article className="game-row expansion-row" key={game.id}>
                                                        <RowArt url={game.thumbnail} />
                                                        <div className="game-info">
                                                            <div className="title-line">
                                                                <a
                                                                    className="game-title"
                                                                    href={`https://boardgamegeek.com/boardgame/${game.id}`}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    title="Open on BoardGameGeek"
                                                                >
                                                                    {game.name}
                                                                </a>
                                                                <button
                                                                    type="button"
                                                                    className="edit-details"
                                                                    aria-label={`Edit details for ${game.name}`}
                                                                    title="Edit details"
                                                                    onClick={() => setDetail(game.id)}
                                                                >
                                                                    <Pencil size={14} aria-hidden />
                                                                </button>
                                                            </div>
                                                            <p>
                                                                {parentCull
                                                                    ? preference.mustKeep
                                                                        ? 'Marked keep; review parent on cull list'
                                                                        : 'Bundle with parent being culled'
                                                                    : game.parentName || 'Parent not mapped'}
                                                            </p>
                                                        </div>
                                                        {thumbControls(game, preference)}
                                                        <label className="check-label">
                                                            <Checkbox
                                                                checked={!!preference.mustKeep}
                                                                onCheckedChange={checked =>
                                                                    void change(game.id, { mustKeep: checked === true })
                                                                }
                                                            />
                                                            Keep module
                                                        </label>
                                                    </article>
                                                );
                                            })}
                                        <p className="footnote">
                                            Expansion choices are saved separately and do not change the standalone target. Review
                                            expansions when removing their parent.
                                        </p>
                                    </section>
                                ) : (
                                    <section className={`game-list ${view === 'cull' ? 'cull-list' : ''}`}>
                                        <div className="list-heading">
                                            <span>
                                                {view === 'cull'
                                                    ? 'Lowest keep scores first'
                                                    : view === 'ranking'
                                                        ? 'Highest keep scores first'
                                                        : `Sorted by ${describeSort(sort).toLowerCase()} · use the pencil to edit details`}
                                            </span>
                                            <span>{visible.length} games</span>
                                        </div>
                                        {view === 'cull' && (
                                            <div className="list-instruction">
                                                <Info size={18} />
                                                Check “Keep this game” to retain it. The next candidate takes its place.
                                            </div>
                                        )}
                                        {view === 'cull' && usesStorePrices && (
                                            <p className="price-credit">
                                                New prices include store prices from{' '}
                                                <a href="https://boardgameprices.com" target="_blank" rel="noreferrer">
                                                    BoardGamePrices.com
                                                </a>
                                                .
                                            </p>
                                        )}
                                        {view === 'preferences' && (
                                            <div className="all-columns" role="row">
                                                {(
                                                    [
                                                        ['reviewed', '✓'],
                                                        ['name', 'Game'],
                                                        ['rating', 'Rating'],
                                                        ['thumb', 'Preference'],
                                                        ['box', 'Box size'],
                                                        ['keep', 'Must keep'],
                                                    ] as [SortKey, string][]
                                                ).map(([key, label]) => (
                                                    <span
                                                        key={key}
                                                        role="columnheader"
                                                        aria-sort={
                                                            sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                                                        }
                                                    >
                                                        <button
                                                            type="button"
                                                            onClick={() => setSort(current => nextSort(current, key))}
                                                            aria-label={`Sort by ${SORTS[key].label}`}
                                                            className={sort.key === key ? 'active' : ''}
                                                        >
                                                            {label}
                                                            {sort.key === key ? (
                                                                sort.dir === 1 ? (
                                                                    <ArrowUp size={13} />
                                                                ) : (
                                                                    <ArrowDown size={13} />
                                                                )
                                                            ) : null}
                                                        </button>
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {view === 'cull' && (
                                            <div className="cull-columns" aria-hidden="true">
                                                <span>#</span>
                                                <span>Game</span>
                                                <span>Why it’s on the cull list</span>
                                                <span>Keep score</span>
                                                <span>Est. value</span>
                                                <span>Preference</span>
                                                <span>Box size</span>
                                                <span>Keep or trade in</span>
                                            </div>
                                        )}
                                        {visible.length === 0 ? (
                                            <div className="empty">No games match this view.</div>
                                        ) : (
                                            visible.map((game, index) =>
                                            {
                                                return (
                                                    <article
                                                        className={`game-row ${game.preference.mustKeep ? 'locked' : ''}`}
                                                        key={game.id}
                                                    >
                                                        <RowArt url={game.thumbnail} />
                                                        <span className="row-rank">
                                                            {view === 'preferences' ? (
                                                                game.preference.reviewed ? (
                                                                    <Check size={18} />
                                                                ) : (
                                                                    <span className="unreviewed-mark" />
                                                                )
                                                            ) : (
                                                                index + 1
                                                            )}
                                                        </span>
                                                        <div className="game-info">
                                                            <div className="title-line">
                                                                <a
                                                                    className="game-title"
                                                                    href={`https://boardgamegeek.com/boardgame/${game.id}`}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    title="Open on BoardGameGeek"
                                                                >
                                                                    {game.name}
                                                                    {game.preference.mustKeep && <LockKeyhole size={15} />}
                                                                </a>
                                                                <button
                                                                    type="button"
                                                                    className="edit-details"
                                                                    aria-label={`Edit details for ${game.name}`}
                                                                    title="Edit details"
                                                                    onClick={() => setDetail(game.id)}
                                                                >
                                                                    <Pencil size={14} aria-hidden />
                                                                </button>
                                                            </div>
                                                            <p>
                                                                {game.group || 'Classification needed'}
                                                                <span>
                                                                    {' '}
                                                                    · {game.minutes ? `${game.minutes} min` : 'Time unknown'} ·{' '}
                                                                    {game.minPlayers}–{game.maxPlayers} players · BGG weight{' '}
                                                                    {game.complexity?.toFixed(2) ?? 'unknown'}/5
                                                                </span>
                                                            </p>
                                                            {view === 'ranking' && (
                                                                <FactorChips
                                                                    factors={keepFactors(game, state, result)}
                                                                    onOpen={setDetail}
                                                                />
                                                            )}
                                                        </div>
                                                        {view === 'cull' && (
                                                            <div className="cull-explanation">
                                                                <span className="mobile-reason-label">Why it’s on the cull list</span>
                                                                <p className="cull-reason">{cullReasons(game, state, result).join(' ')}</p>
                                                                <FactorChips
                                                                    factors={keepFactors(game, state, result)}
                                                                    onOpen={setDetail}
                                                                />
                                                            </div>
                                                        )}
                                                        <div className="rating-value">
                                                            <strong>
                                                                {view === 'preferences' ? game.rating.toFixed(1) : game.score.toFixed(1)}
                                                            </strong>
                                                            <span>{view === 'preferences' ? 'rating' : 'keep score'}</span>
                                                        </div>
                                                        {view === 'cull' && <PriceCell quote={prices[game.id]} />}
                                                        {thumbControls(game, game.preference)}
                                                        <Choice
                                                            value={game.preference.box == null ? 'unknown' : String(game.preference.box)}
                                                            onChange={choice =>
                                                                void change(game.id, { box: choice === 'unknown' ? null : Number(choice) })
                                                            }
                                                            label={`Box size for ${game.name}`}
                                                        />
                                                        <div className={view === 'cull' ? 'trade-cell' : 'contents'}>
                                                            <label className="check-label keep-check">
                                                                <Checkbox
                                                                    checked={!!game.preference.mustKeep}
                                                                    aria-label={`${view === 'cull' ? 'Keep this game' : 'Must keep'}: ${game.name}`}
                                                                    onCheckedChange={checked =>
                                                                    {
                                                                        void change(game.id, { mustKeep: checked === true });
                                                                        if (view === 'cull' && checked)
                                                                        {
                                                                            setNotice(`${game.name} retained. The cull list has updated.`);
                                                                        }
                                                                    }}
                                                                />
                                                                {view === 'cull' ? 'Keep this game' : 'Must keep'}
                                                            </label>
                                                            {view === 'cull' && (
                                                                <ConditionChoice
                                                                    value={game.preference.condition ?? DEFAULT_CONDITION}
                                                                    onChange={condition => void change(game.id, { condition: condition })}
                                                                    label={`Trade-in condition for ${game.name}`}
                                                                />
                                                            )}
                                                        </div>
                                                    </article>
                                                );
                                            })
                                        )}
                                    </section>
                                )}
                            </>
                        )}
                        <footer>
                            Snapshot supplied October 4, 2026 · Choices save to your private collection · Draft classifications remain
                            editable
                        </footer>
                    </>
                )}
                {result && (
                    <EbayPanel
                        open={ebayOpen}
                        onOpenChange={setEbayOpen}
                        cull={result.cull}
                        all={result.ranked}
                        prices={prices}
                        profile={profile}
                        demo={demo}
                    />
                )}
                <Sheet
                    open={!!detailGame}
                    onOpenChange={open =>
                    {
                        if (!open)
                        {
                            setDetail(null);
                        }
                    }}
                >
                    <SheetContent className="detail-sheet">
                        <SheetHeader>
                            <SheetTitle>{detailGame?.name}</SheetTitle>
                            <SheetDescription>Edit your copy’s preferences and play experience.</SheetDescription>
                        </SheetHeader>
                        {detailGame && (
                            <div className="detail-fields">
                                <a href={`https://boardgamegeek.com/boardgame/${detailGame.id}`} target="_blank" rel="noreferrer">
                                    View on BoardGameGeek
                                </a>
                                {thumbControls(detailGame, detailPref!)}
                                <label className="check-label">
                                    <Checkbox
                                        checked={!!detailPref?.mustKeep}
                                        onCheckedChange={checked => void change(detailGame.id, { mustKeep: checked === true })}
                                    />
                                    Must keep
                                </label>
                                <label>
                                    Box size
                                    <Choice
                                        value={detailPref?.box == null ? 'unknown' : String(detailPref.box)}
                                        onChange={choice =>
                                            void change(detailGame.id, { box: choice === 'unknown' ? null : Number(choice) })
                                        }
                                        label="Box size"
                                    />
                                </label>
                                <label>
                                    Trade-in condition
                                    <ConditionChoice
                                        value={detailPref?.condition ?? DEFAULT_CONDITION}
                                        onChange={condition => void change(detailGame.id, { condition: condition })}
                                        label="Trade-in condition"
                                    />
                                </label>
                                {(
                                    [
                                        ['personalRating', 'Your rating /10', 1, 10],
                                        ['mean', 'Mean interaction /5', 0, 5],
                                        ['minutes', 'Session minutes', 1, 1440],
                                    ] as const
                                ).map(([key, label, min, max]) => (
                                    <label key={key}>
                                        {label}
                                        <Input
                                            type="number"
                                            min={min}
                                            max={max}
                                            step={key === 'personalRating' ? '.5' : '1'}
                                            value={(detailPref?.[key] === undefined ? detailGame[key] : detailPref[key]) ?? ''}
                                            placeholder="Unknown"
                                            onChange={event =>
                                            {
                                                const newValue = event.target.value === '' ? null : Number(event.target.value);

                                                if (newValue === null || (newValue >= min && newValue <= max))
                                                {
                                                    void change(detailGame.id, { [key]: newValue });
                                                }
                                            }}
                                        />
                                    </label>
                                ))}
                                {(['group', 'theme', 'mode', 'notes'] as const).map(key => (
                                    <label key={key}>
                                        {key === 'group' ? 'Overlap group' : key[0].toUpperCase() + key.slice(1)}
                                        <Input
                                            value={detailPref?.[key] ?? detailGame[key]}
                                            onChange={event => void change(detailGame.id, { [key]: event.target.value })}
                                        />
                                    </label>
                                ))}
                                <p className="hint">
                                    Mean interaction: 0 cooperative/none, 1 mild blocking, 2 denial, 3 targeted setbacks, 4 frequent
                                    attacks, 5 punishing competitive consequences.
                                </p>
                                <p className="hint">
                                    Mark different modes or distinct roles with separate overlap groups. Estimates are yours to correct.
                                </p>
                                <Button variant="outline" onClick={() => setDetail(null)}>
                                    Done
                                </Button>
                            </div>
                        )}
                    </SheetContent>
                </Sheet>
            </div>
        </TooltipProvider>
    );
}
