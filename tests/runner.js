/**
 * Cross-platform test runner for node --test.
 *
 * Usage:
 *   node tests/runner.js               → runs all tests
 *   node tests/runner.js tests/unit    → runs unit tests only
 *   node tests/runner.js tests/integration
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const root = process.argv[2] || 'tests';

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results.sort();
}

const files = findTestFiles(root);

if (files.length === 0) {
  console.error(`No test files found under: ${root}`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) from: ${root}\n`);

const result = spawnSync(
  process.execPath,
  ['--test', ...files],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 0);
