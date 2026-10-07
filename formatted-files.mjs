// Files in the house style (Prettier + Allman braces). `pnpm format` formats them
// and ESLint checks their braces. Vendored code (components/ui, hooks, lib/utils.ts)
// and the unused Cloudflare/Sites leftovers aren't included.
export const FORMATTED = [
    'app/**/*.{ts,tsx}',
    '!app/chatgpt-auth.ts',
    'lib/{bgg,ebay-drafts,groups,listing,model,nkg,openai,preference-sql,prices,profile,sort,text,validation}.ts',
    'db/index.ts',
    'tests/**/*.{ts,mjs}',
    'e2e/**/*.{ts,mjs}',
    'scripts/format.mjs',
    'formatted-files.mjs',
    'playwright.config.ts',
    'vitest.config.ts',
    'next.config.ts',
];
