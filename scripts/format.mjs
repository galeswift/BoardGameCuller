// Formats the converted files: Prettier for spacing and line breaks, then ESLint
// to move opening braces onto their own line (Prettier can't do that itself).
import { execFileSync } from 'node:child_process';
import { FORMATTED } from '../formatted-files.mjs';

const run = (bin, args) => execFileSync(process.execPath, [bin, ...args], { stdio: 'inherit' });

run('node_modules/prettier/bin/prettier.cjs', ['--write', ...FORMATTED]);
run('node_modules/eslint/bin/eslint.js', ['--fix', ...FORMATTED]);
