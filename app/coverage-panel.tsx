import { ChevronRight, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { coverageSummary, type Coverage } from '@/lib/coverage';

/** The one-paragraph version at the top of the cull list. */
export function CoverageSummary({ coverage, cullCount, onOpen }: { coverage: Coverage; cullCount: number; onOpen: () => void })
{
    const [headline, ...details] = coverageSummary(coverage, cullCount);

    return (
        <section className={`coverage-summary ${coverage.lost.length ? 'has-loss' : ''}`} aria-label="Play-experience coverage">
            <ShieldCheck size={22} aria-hidden />
            <div>
                <strong>{headline}</strong>
                {details.map(line => (
                    <p key={line}>{line}</p>
                ))}
            </div>
            <Button variant="outline" onClick={onOpen}>
                See coverage
                <ChevronRight />
            </Button>
        </section>
    );
}

/** Every broad kind of game in the collection, with how many stay after the cull. */
export function CoveragePanel({ coverage, cullCount }: { coverage: Coverage; cullCount: number })
{
    const largest = Math.max(1, ...coverage.experiences.map(experience => experience.before));
    const sorted = [...coverage.experiences].sort((a, b) => b.before - a.before || a.label.localeCompare(b.label));

    return (
        <section className="coverage">
            <div className="coverage-head">
                <h2>What your collection covers</h2>
                {coverageSummary(coverage, cullCount).map(line => (
                    <p key={line}>{line}</p>
                ))}
                <p className="hint">
                    Each bar is one kind of play experience. The solid part is what you keep; the pale part is on the cull list. A game can
                    count toward several kinds.
                    {!coverage.tagged && ' Sync from BGG to add mechanism-based kinds like deck building and deduction.'}
                </p>
            </div>
            <ul className="coverage-bars">
                {sorted.map(experience => (
                    <li key={experience.label} className={experience.kept === 0 ? 'lost' : ''}>
                        <span className="coverage-label">{experience.label}</span>
                        <span
                            className="coverage-track"
                            role="img"
                            aria-label={`${experience.label}: keeping ${experience.kept} of ${experience.before}`}
                        >
                            <span className="coverage-before" style={{ width: `${(experience.before / largest) * 100}%` }}>
                                <span className="coverage-kept" style={{ width: `${(experience.kept / experience.before) * 100}%` }} />
                            </span>
                        </span>
                        <span
                            className="coverage-count"
                            title={experience.culled.length ? `Culling: ${experience.culled.join(', ')}` : undefined}
                        >
                            {experience.kept} of {experience.before}
                        </span>
                    </li>
                ))}
            </ul>
            {coverage.lostGroups.length > 0 && (
                <div className="coverage-groups">
                    <h3>Play groups with nothing left</h3>
                    <p className="hint">Every game in these play groups is on the cull list.</p>
                    <ul>
                        {coverage.lostGroups.map(lostGroup => (
                            <li key={lostGroup.group}>
                                <strong>{lostGroup.group}</strong>: {lostGroup.games.join(', ')}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}
