// Formats the house-style files: Prettier for spacing and line breaks, then ESLint
// to move opening braces onto their own line (Prettier can't do that itself).
import { execFileSync } from 'node:child_process';
import { FORMATTED } from '../formatted-files.mjs';

function run(bin, args)
{
    execFileSync(process.execPath, [bin, ...args], { stdio: 'inherit' });
}

const include = FORMATTED.filter(pattern => !pattern.startsWith('!'));
const exclude = FORMATTED.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));

run('node_modules/prettier/bin/prettier.cjs', ['--log-level', 'warn', '--write', ...FORMATTED]);
try
{
    run('node_modules/eslint/bin/eslint.js', ['--fix', ...exclude.flatMap(pattern => ['--ignore-pattern', pattern]), ...include]);
}
catch
{
    // ESLint exits non-zero when other (non-style) problems remain; the fixes are
    // still applied and the problems are listed above.
}
