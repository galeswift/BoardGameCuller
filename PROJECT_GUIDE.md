# Collection Cull — project guide

Source snapshot: 5df3f40e5aadb17ad0074fc2e0df392f54881767
Current site: https://galeswift-collection-cull.galeswift.chatgpt.site

This is the complete tracked source of the deployed project, including the
complexity comparison update. Git history, installed dependencies, generated
builds, local environment files, and live database records are not included.

## Main files

- lib/model.ts: keep scoring, complexity cutoff, overlap grouping, explanations,
  and CSV parsing.
- app/collection-app.tsx: collection UI and preference editing.
- app/globals.css: appearance and layout.
- app/api/state/route.ts: authenticated collection/preference storage API.
- lib/collection.json: original collection seed; live imports are in the database.
- db/schema.ts and drizzle/: database tables and SQL migration.
- tests/complexity.test.mjs: complexity matching regression checks.

## Local development

Use Node 24 or later and the pnpm version declared in package.json.
From this folder:

```sh
pnpm install --frozen-lockfile
pnpm build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_sudden_reptil.sql
pnpm dev
```

Apply the SQL migration once to a fresh local database. After it has been applied,
restart development with `pnpm dev`; do not repeat that migration.

A clean checkout defaults to the portable development profile. Open the loopback
URL printed by the dev server, normally http://localhost:5173, then visit
http://localhost:5173/signin-with-chatgpt?return_to=/ to use the local test identity.
The simulated sign-in works only for loopback development, not production.

Validation:

```sh
node --experimental-strip-types --test tests/complexity.test.mjs
node node_modules/typescript/bin/tsc --noEmit
pnpm build
```

The local database starts with the original collection and neutral preferences.
To transfer your current choices, use the live site's JSON backup button and
import that backup into the local app after signing in. The source ZIP does not
contain your saved preferences.

## GitHub and hosting

You can create a GitHub repository and commit this folder normally. The ZIP has
no .git folder, so initialize a new repository. Keep .gitignore in place.

Production currently uses Sites hosting, a Cloudflare Worker runtime, Cloudflare
D1 storage, and dispatch-owned ChatGPT sign-in. Storing code in GitHub does not
move those services or connect a new GitHub repository to the current site.

For another hosting provider, configure the database and replace or integrate the
production authentication boundary first. The current API expects trusted
identity headers supplied by Sites. Do not expose a deployment that trusts
identity headers supplied directly by arbitrary visitors.

The project's README.md contains the underlying starter's runtime details.
