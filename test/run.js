#!/usr/bin/env node
/**
 * Test runner.
 *
 *   npm test                    run every test file
 *   npm test -- users           only files whose path contains "users"
 *   npm test -- routes          only the route tests
 *   npm test -- models/define   filters match the whole relative path
 *   npm test -- users roles     several filters are OR-ed
 *   npm test -- -v              stream full TAP output instead of a summary
 *
 * Each file is a standalone node-tap program, so it is executed with plain
 * node. That is deliberate: the `tap` CLI renders its UI with ink, whose
 * bundled react-reconciler cannot drive the React 19 this project depends on.
 *
 * This file is the harness, not a test — discovery only picks up *.test.js,
 * so it never tries to run itself.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

const colour = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', bold: '', off: '' };

function discover(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return discover(full);
    return entry.name.endsWith('.test.js') ? [full] : [];
  });
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: root });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Counts the top-level (non-indented) TAP assertions in a file's output. */
function tally(output) {
  let passed = 0;
  let failed = 0;
  for (const line of output.split('\n')) {
    if (/^ok \d+/.test(line)) passed++;
    else if (/^not ok \d+/.test(line)) failed++;
  }
  return { passed, failed };
}

const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const filters = args.filter((arg) => !arg.startsWith('-'));

if (!fs.existsSync(testDir)) {
  console.error('No test/ directory found.');
  process.exit(1);
}

let files = discover(testDir).sort();
if (filters.length > 0) {
  files = files.filter((file) => {
    const relative = path.relative(root, file).replace(/\\/g, '/').toLowerCase();
    return filters.some((filter) => relative.includes(filter.toLowerCase()));
  });
}

if (files.length === 0) {
  console.error(`No test files match: ${filters.join(', ') || '(none)'}`);
  process.exit(1);
}

const failures = [];
let totalPassed = 0;
let totalFailed = 0;

for (const file of files) {
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const { code, output } = await runFile(file);
  const { passed, failed } = tally(output);

  totalPassed += passed;
  totalFailed += failed;

  const ok = code === 0 && failed === 0;
  if (!ok) failures.push({ relative, output });

  const mark = ok ? `${colour.green}✓${colour.off}` : `${colour.red}✗${colour.off}`;
  const counts = `${colour.dim}${passed} passed${failed ? `, ${failed} failed` : ''}${colour.off}`;
  console.log(`${mark} ${relative} ${counts}`);

  if (verbose) console.log(output);
}

if (failures.length > 0 && !verbose) {
  for (const failure of failures) {
    console.log(`\n${colour.red}${colour.bold}── ${failure.relative} ──${colour.off}`);
    console.log(failure.output.trimEnd());
  }
}

const summary = `${files.length} file(s), ${totalPassed} passed, ${totalFailed} failed`;
console.log(
  failures.length > 0
    ? `\n${colour.red}${colour.bold}FAIL${colour.off} ${summary}`
    : `\n${colour.green}${colour.bold}PASS${colour.off} ${summary}`
);

process.exit(failures.length > 0 ? 1 : 0);
