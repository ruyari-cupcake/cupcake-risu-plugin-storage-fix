// Apply one plausible behavioral defect to a disposable copy; every mutant must fail tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MUTANT_TIMEOUT_MS = 30000;
const source = fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8');
const MUTANTS = [
  ['allow account backend', "if (env.localStorage.getItem('accountst') === 'able') return 'account';", ''],
  ['allow node backend', "if (env.isNode) return 'node';", ''],
  ['allow Tauri backend', "if (env.isTauri) return 'tauri';", ''],
  ['accept invalid index trash', '&& Array.isArray(value.entries) && Array.isArray(value.trash)', '&& Array.isArray(value.entries)'],
  ['drain non-index chat files', 'if (!INDEX_PREFIX.startsWith(prefix.slice(0, INDEX_PREFIX.length))) return null;', ''],
  ['offer dead pointer as candidate', 'if (id !== excludeId) {', 'if (true) {'],
  ['oldest candidate first', 'b.lastModified - a.lastModified', 'a.lastModified - b.lastModified'],
  ['hide missing large values', 'missingLarge: large.filter((entry) => !names.has(coldName(entry.l))).length', 'missingLarge: 0'],
  ['ignore changed pointer', "if (storage[POINTER_KEY] !== pointer) throw new FixError('CHANGED');", ''],
  ['overwrite healthy storage', "if (current.state === 'healthy') throw new FixError('NOT_BROKEN');", ''],
  ['skip candidate revalidation', "if (candidate.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');", ''],
  ['mutate a copy instead of live object', 'storage[POINTER_KEY] = candidateId;', '({ ...storage })[POINTER_KEY] = candidateId;'],
  ['reset stores null instead of deleting', 'delete storage[POINTER_KEY];', 'storage[POINTER_KEY] = null;'],
  ['ignore OPFS database flag', "if (env.localStorage.getItem('opfs_flag!') === 'able') {", 'if (false) {'],
  ['ignore migrated marker', "!keys.includes(DATABASE_KEY) || await env.forage.getItem('migrated')", '!keys.includes(DATABASE_KEY)'],
  ['big-endian block lengths', 'getUint32(0, true)', 'getUint32(0, false)'],
  ['skip compressed block decoding', 'if (compression === 1) data = await readGzip(env, data);', ''],
  ['confirm memory rather than saved file', 'predicate(saved.pointer)', 'predicate(liveStorage(env)[POINTER_KEY] ?? null)'],
  ['reread without backup gate', 'shouldRead = latest > lastBackup;', 'shouldRead = true;'],
  ['confirm unknown file as empty', "saved.format === 'risusave' && saved.hasBlock && predicate(saved.pointer)", 'predicate(saved.pointer ?? null)'],
  ['confirm save without plugin block', "saved.format === 'risusave' && saved.hasBlock && predicate(saved.pointer)", "saved.format === 'risusave' && predicate(saved.pointer)"],
  ['sample keys keep non-string entries', ".filter((entry) => typeof entry?.k === 'string');", ';'],
  ['ignore cancellation', "if (signal && signal.aborted) throw new FixError('CANCELLED');", ''],
  ['commit missing IndexedDB creation', 'request.transaction.abort();', ''],
  ['open writable IndexedDB transaction', "db.transaction(OBJECT_STORE, 'readonly')", "db.transaction(OBJECT_STORE, 'readwrite')"],
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rpsf-mutants-'));
let survivors = 0;
try {
  for (const [label, from, to] of MUTANTS) {
    if (source.split(from).length !== 2) throw new Error(`mutant "${label}" must match src/core.js exactly once`);
    const mutated = source.replace(from, to);
    new vm.Script(mutated, { filename: label });
    const dir = path.join(work, label.replace(/\W+/g, '-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/core.js'), mutated);
    fs.copyFileSync(path.join(ROOT, 'tests/core.test.cjs'), path.join(dir, 'tests/core.test.cjs'));
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(dir, 'tests/core.test.cjs')], {
      encoding: 'utf8', timeout: MUTANT_TIMEOUT_MS, env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (run.error || run.signal || ![0, 1].includes(run.status)) {
      throw new Error(`mutant "${label}" did not complete normally: ${run.error || run.signal || run.stderr}`);
    }
    const output = run.stdout.replace(/\u001b\[[0-9;]*m/g, '');
    const failed = Number(/(?:ℹ|#) fail (\d+)/.exec(output)?.[1] || 0);
    const killed = run.status === 1 && failed > 0 && output.includes('AssertionError');
    if (!killed) survivors += 1;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${label} (failing tests: ${failed})`);
    if (!killed && run.status !== 0) console.error(run.stdout, run.stderr);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`${MUTANTS.length - survivors}/${MUTANTS.length} mutants KILLED`);
process.exitCode = survivors ? 1 : 0;
