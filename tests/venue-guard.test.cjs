// tests/live/venue-guard.sh: the release gate stops when a file it reads changes during the run
// (2026-11-03: the driver was edited while run-all.sh was mid-scenario, so later steps mixed versions).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.join(__dirname, 'live/venue-guard.sh');

function fakeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpsf-venue-'));
  for (const file of ['src/core.js', 'dist/console.js', 'tests/live/drive.mjs', 'scripts/build.cjs', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
  }
  fs.mkdirSync(path.join(dir, 'tests/live/work'), { recursive: true });
  return dir;
}

function gate(dir, body) {
  const script = ['set -euo pipefail', `source '${GUARD}'`, 'venue_freeze', ...body].join('\n');
  return spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
}

test('an unchanged tree passes every step, and env prefixes reach the step command', (t) => {
  const dir = fakeTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = gate(dir, ['step true', 'LOCAL_CONSOLE=1 step sh -c \'test "$LOCAL_CONSOLE" = 1\'', 'echo done']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /done/);
});

test('scenario output under tests/live/work does not stop the gate', (t) => {
  const dir = fakeTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = gate(dir, ['step sh -c "echo result > tests/live/work/result.json"', 'echo done']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /done/);
});

for (const file of ['src/core.js', 'dist/console.js', 'tests/live/drive.mjs', 'scripts/build.cjs', 'package.json']) {
  test(`an edit to ${file} during a step stops the gate after that step`, (t) => {
    const dir = fakeTree();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = gate(dir, ['step true', `step sh -c "echo edited >> ${file}"`, 'echo unreachable']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /VENUE_CHANGED_MID_RUN after: sh -c/);
    assert.doesNotMatch(run.stdout, /unreachable/);
  });
}

test('a new file the gate would read also stops it', (t) => {
  const dir = fakeTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = gate(dir, ['step sh -c "echo x > tests/new.test.cjs"', 'echo unreachable']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /VENUE_CHANGED_MID_RUN/);
});
