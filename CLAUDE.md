# Collection Cull — notes for Claude

Board game collection culler: scores a BGG collection, finds overlapping games, builds a cull
list, estimates values, exports Noble Knight trade-in sheets and eBay draft listings.
Live: https://boardgameculler-production.up.railway.app/ · Repo: github.com/galeswift/BoardGameCuller

## Stack

Next.js 16 (React 19) app + API routes, Docker on Railway, Postgres (tables auto-created in
`db/index.ts`: collection_state, preferences, prices, bgg_reviews). pnpm 11.
Vitest (unit/API tests against PGlite) + Playwright (browser tests against fake BGG,
fake BoardGamePrices and PGlite over the wire, see `e2e/support/services.mjs`).

## Working agreements

- Commit and push only when the user asks. Before every commit, check the staged diff for the
  real secret values from `.env.local` (`BGG_API_TOKEN`, `OPENAI_API_KEY`) and refuse to commit
  if any appear. Never print, copy or commit those values.
- A hook blocks recursive `rm` / `git rm -r` (even dry runs). Show the exact command and let the
  user run it.
- Before finishing a change: `npx tsc --noEmit -p .`, `pnpm test`, `pnpm test:e2e`, lint.
  Lint baseline is 2 known problems in `app/collection-app.tsx` (unused `defaults` import,
  react-hooks set-state-in-effect in `load`); anything else is new.
- E2E must never call real OpenAI: `playwright.config.ts` blanks `OPENAI_API_KEY`/`OPENAI_MODEL`.
- Verify AI-facing changes with a few real samples (keys in `.env.local`; load with
  `set -a; . ./.env.local; set +a`, run a throwaway `npx tsx` script). Keep runs small: they cost money.

## Code style (the user's pre-AI style; important)

- Allman braces (opening brace on its own line), 4-space indent, single quotes, semicolons.
- Every if/else/for/while body in braces on new lines — no single-line `if (x) return;`.
- One declaration per statement. Blank lines between logical steps inside functions.
- Descriptive names. No single-letter or cryptic names except `(a, b)` sort comparators and
  `_` for unused params. Don't shadow outer variables.
- `pnpm format` (Prettier + `@stylistic` via ESLint) formats files listed in `formatted-files.mjs`;
  add new files there. Vendored shadcn code (components/ui, hooks, lib/utils.ts) is excluded.

## Product decisions

- **Access:** one shared `APP_PASSWORD`. Data is per *profile* = BGG username. Default profile
  `galeswift` is seeded from `lib/collection.json` and can't be removed; other profiles can.
- **Demo:** "Try the demo" on the landing page (`/login`) sets a demo cookie (`demoToken()`,
  1 day). `getViewer()` accepts owner or demo; `getUser()` stays owner-only, so every write route
  stays closed to the demo. The demo gets the seed collection with default settings (never saved
  data), reads cached prices only, gets template eBay copy (no BGG/OpenAI calls), and keeps edits
  in the tab (`demoRef` in `enqueue`). The UI hides the picker, Sync, Import and Check prices.
- **Prices:** BGG GeekMarket (used + new) and BoardGamePrices.com (new; in-stock US stores only;
  merge all items for a BGG ID; credit and link back; cache ≥ 1h). eBay pricing was removed (no
  API access). No scraping (Amazon, retailers, BGG price-history pages); Keepa/TCGAPIs declined.
  Per source: USD median. Average sources with ≥3 listings, else average all thin ones.
  Skip accessory-only GeekMarket notes; with ≥3 store prices drop new < 50% and used < 30% of
  retail. Shipping kept separate. Quotes cached 14 days; bump `QUOTE_VERSION` when rules change;
  quotes record which sources answered and are rechecked when a source becomes available.
  Deluxe/Kickstarter outliers are accepted (user filters them manually).
- **eBay listings:** Seller Hub bulk *draft* CSV, category 180349, condition 1000 (New) / 3000
  (others). Suggested price = 10% under the market estimate for the copy's condition (no eBay
  sold data exists to undercut). No photos.
- **Descriptions (OpenAI, `gpt-5-mini` default; template fallback without a key):** casual seller
  voice using the user's One Deck Dungeon paragraph as the example; ≤45/≤40 words; never mention
  ratings/ranks; never invent the seller's experience; summarise (never quote) BGG Reviews-forum
  posts and comments rated ≥7; banned stock phrases; punctuation clean-up; "BoardGameGeek" named
  in only ~1 in 4 listings (`mayMentionBgg`, id % 4). **Variety across listings is an important
  requirement.** The model writes one free-form 45–80 word description (no fixed intro/appeal
  slots; it's split into those fields by paragraph). Each game gets a stable opening idea
  (`openingFor`, 8 shapes). `formulaProblems` flags "players/people like…" sentences, "[Game] is
  a…" openings, hype words, "Great for/if…" sign-offs and adjective fragments ("Calm and
  puzzly."); a flagged draft gets one rewrite with the reasons, and the better of the two is
  kept. Don't put example phrases in the prompt: the model copies them into every listing.
- **Play groups:** auto-assigned with OpenAI (after Sync from BGG, or "Assign play groups"),
  batches of 60, reuse existing groups, retry skipped games, never overwrite. No group-size cap:
  scoring already only compares games of similar weight within a group.
- **Similarity (overlap deductions):** games only compare within one play group + mode and
  compatible weight. With BGG tags (categories, mechanisms, families minus sales/catalogue
  families like Crowdfunding/Misc/Digital Implementations), similarity = 0.1 + 0.6 × tag match
  + 0.1 each for length, weight, players. Tag match = rarity-weighted (IDF within the collection)
  cosine, scaled so 0.5 counts as full (~90th percentile: sequels/editions/series). Calibrated so
  Mythwind vs Fateforge ≈ 67% (user expects 50–70%); sequels ~96–99%. Games without tags
  (collections not re-synced since tags were added) use the old theme-based formula.
  The sample collection (`lib/collection.json`) has tags backfilled.
- **Big collections:** limit 20,000 games (`MAX_COLLECTION_GAMES`, also the max target), uploads/saves
  up to 30 MB. Sync from BGG runs in the background (`lib/sync-jobs.ts`, `sync_jobs` table):
  POST /api/bgg starts it (202), GET polls progress; the page polls every 1.5 s, resumes after a
  reload, and a job silent for 3 min is reported as stopped. Game lists with 150+ rows are
  virtualized (`app/virtual-rows.tsx`, TanStack window virtualizer, rows measured).
- **Noble Knight export:** fills the bundled `public/nkg-trade-template.xlsx`; per-game condition,
  default Used.
- **UI:** "All Games" tab (renamed from Preferences) with sortable headers; reason chips with
  per-kind colours; Fraunces/Figtree fonts. Each row shows the game's BGG thumbnail faded in
  behind the title (`RowArt`, `.row-art`); thumbnails are stored at sync and only BGG image-CDN
  URLs pass `bggImageUrl` (they go into CSS `url()`). E2E aborts requests to the CDN.
- **Mean interaction** deduction defaults to 0 (off); users can raise it in Scoring.
- **Reasons over numbers** (from `CLAUDE_TASKS.md` #2): cull rows lead with plain sentences from
  `cullReasons` (rating sentence always first so "it" is unambiguous; max 3), chips stay for
  details, and the keep score is shown muted. The CSV export still uses `cullExplanation`.
- **Coverage** (`CLAUDE_TASKS.md` #1, `lib/coverage.ts`, Coverage tab + summary on the cull list):
  headline % = play groups that keep ≥1 game (broad kinds alone are ~always 100%, so they're the
  second line: lost / "thinner afterwards" = 3+ games keeping under half). 24 broad experiences
  from weight, length, players, mode and BGG tags (tag-based ones hidden until a collection has
  tags). Lists play groups that lose every game.
- **README:** the user's own blurb (with its parentheticals and small typos) is intentional —
  don't "fix" it.
- Moving the UI to Vite + React was discussed and tabled.

## In progress (update or remove when done)

Nothing in progress.
