// Apply one plausible behavioral defect to a disposable copy; every mutant must fail tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MUTANT_TIMEOUT_MS = 30000;
const OBSOLETE_SAVE_TIMEOUT_MS = 60000;
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
  ['ignore OPFS database flag', "if (env.localStorage.getItem('opfs_flag!') === 'able' && env.opfsWritable) {", 'if (false) {'],
  ['ignore migrated marker', "!keys.includes(DATABASE_KEY) || await env.forage.getItem('migrated')", '!keys.includes(DATABASE_KEY)'],
  ['big-endian block lengths', 'getUint32(0, true)', 'getUint32(0, false)'],
  ['skip compressed block decoding', 'if (compression === 1) data = await readGzip(env, data);', ''],
  ['confirm memory rather than saved file', '        saved = await readAtLocation(env, location);', "saved = { format: 'risusave', hasBlock: true, pointer: liveStorage(env)?.[POINTER_KEY] ?? null };"],
  ['reread without backup gate', "const shouldRead = lastBackup > baseline && (location.kind === 'opfs' || newer || unknownRetries > 0);", 'const shouldRead = true;'],
  ['confirm unknown file as empty', '        saved = await readAtLocation(env, location);', "saved = await readAtLocation(env, location); if (saved.format === 'unknown') saved = { format: 'risusave', hasBlock: true, pointer: null };"],
  ['confirm save without plugin block', "saved.format === 'risusave' && saved.hasBlock && await predicate(saved.pointer)", "saved.format === 'risusave' && await predicate(saved.pointer)"],
  ['sample keys keep non-string entries', ".filter((entry) => typeof entry?.k === 'string');", ';'],
  ['ignore cancellation', "if (signal && signal.aborted) throw new FixError('CANCELLED');", ''],
  ['commit missing IndexedDB creation', 'request.transaction.abort();', ''],
  ['open writable IndexedDB transaction', "db.transaction(OBJECT_STORE, 'readonly')", "db.transaction(OBJECT_STORE, 'readwrite')"],
  ['ignore unsettled persisted pointer', "if (saved.format !== 'risusave' || !saved.hasBlock || saved.pointer !== pointer) throw new FixError('NOT_SETTLED');", ''],
  ['capture recovery baseline after edit', "{ signal, onWaiting, location, baseline, editedAt });\n  }\n\n  async function reset", "{ signal, onWaiting, location, editedAt });\n  }\n\n  async function reset"],
  ['capture reset baseline after edit', "{ signal, onWaiting, location, baseline, editedAt });\n  }\n\n  function toHex", "{ signal, onWaiting, location, editedAt });\n  }\n\n  function toHex"],
  ['freeze OPFS receipt after backup announcement', "location.kind === 'opfs' || newer || unknownRetries > 0", 'newer || unknownRetries > 0'],
  ['never retry unknown IndexedDB receipt', 'unknownRetries = SAVE_UNKNOWN_RETRY_COUNT;', 'unknownRetries = 0;'],
  ['retry unknown IndexedDB receipt forever', 'if (!newer) unknownRetries -= 1;', ''],
  ['retry readable stale IndexedDB receipt', "if (saved.format !== 'unknown') unknownRetries = 0;", ''],
  ['reject valid successor indexes', "return (await readIndex(env, root, saved, signal)).state === 'healthy';", 'return false;'],
  ['trust successor id without its file', "return (await readIndex(env, root, saved, signal)).state === 'healthy';", 'return true;'],
  ['accept the original dead id as successor', "if (typeof saved !== 'string' || saved === deadPointer) return false;", "if (typeof saved !== 'string') return false;"],
  ['do not await successor verification', '&& await predicate(saved.pointer)', '&& predicate(saved.pointer)'],
  ['classify all handle errors as missing', "error?.name === 'NotFoundError' ? 'missing' : 'uncertain'", "'missing'"],
  ['classify access or decode failures as unreadable', "return { state: 'uncertain' };", "return { state: 'unreadable' };"],
  ['classify decoded bad JSON as uncertain', "try { value = bytes && JSON.parse(new TextDecoder().decode(bytes)); } catch (error) {\n      return { state: 'unreadable' };", "try { value = bytes && JSON.parse(new TextDecoder().decode(bytes)); } catch (error) {\n      return { state: 'uncertain' };"],
  ['allow uncertain pointer edits', "if (current.state !== 'missing' && current.state !== 'unreadable') throw new FixError('UNCERTAIN');", ''],
  ['hide uncertain candidate files', "if (result.state === 'uncertain') uncertainCount += 1;", ''],
  ['ignore missing OPFS capability', "if (!env.hasOpfs) return 'opfs';", ''],
  ['ignore missing decompression capability', "if (!env.hasDecompression) return 'decompression';", ''],
  ['allow mutations on unsupported browsers', "if (missingCapability(env)) throw new FixError('UNSUPPORTED_BROWSER');", ''],
  ['ignore createWritable database gate', "env.localStorage.getItem('opfs_flag!') === 'able' && env.opfsWritable", "env.localStorage.getItem('opfs_flag!') === 'able'"],
  ['call never-used plugin storage not ready', 'if (Array.isArray(db?.plugins)) return null;', ''],
  ['hide account logout hint', "env.localStorage.getItem('dosync') === 'avoid'", 'false'],
  ['skip settle', '&& env.now() - lastChangeAt >= SAVE_SETTLE_MS', ''],
  ['settle 0', 'const SAVE_SETTLE_MS = STOCK_PLUGIN_FLUSH_DELAY_MS + STOCK_SAVE_IDLE_MS + SAVE_POLL_INTERVAL_MS;', 'const SAVE_SETTLE_MS = 0;'],
  ['ignore live pointer', '&& saved.pointer === livePointer', ''],
  ['treat undefined unequal to null', 'const currentPointer = liveStorage(env)?.[POINTER_KEY] ?? null;', 'const currentPointer = liveStorage(env)?.[POINTER_KEY];'],
  ['settle from wait start instead of last change', 'lastChangeAt = env.now();', 'lastChangeAt = started;'],
  ['IDB drop matched read before settle', 'const shouldRead = lastBackup > baseline', "saved = { format: 'unknown' }; const shouldRead = lastBackup > baseline"],
  ['read after settle without a newer backup', "const shouldRead = lastBackup > baseline && (location.kind === 'opfs' || newer || unknownRetries > 0);",
    "const shouldRead = env.now() - lastChangeAt >= SAVE_SETTLE_MS || (lastBackup > baseline && (location.kind === 'opfs' || newer || unknownRetries > 0));"],
  ['keep stale IDB receipt after newer unknown read', '        saved = await readAtLocation(env, location);', "const nextSaved = await readAtLocation(env, location); if (nextSaved.format !== 'unknown') saved = nextSaved;"],
  ['sample live pointer before awaited verification',
    "const accepted = saved.format === 'risusave' && saved.hasBlock && await predicate(saved.pointer);\n      throwIfCancelled(signal);\n      requireWeb(env);\n      // Sample after all awaited reads/verification: a plugin can flush during either one.\n      // Deleting the live key gives undefined, while the persisted parser reports null.\n      const currentPointer = liveStorage(env)?.[POINTER_KEY] ?? null;",
    "const currentPointer = liveStorage(env)?.[POINTER_KEY] ?? null;\n      const accepted = saved.format === 'risusave' && saved.hasBlock && await predicate(saved.pointer);\n      throwIfCancelled(signal);\n      requireWeb(env);"],
  ['reintroduce a fixed total cut', '      const now = env.now();', `      const now = env.now(); if (now - (editedAt ?? started) >= ${OBSOLETE_SAVE_TIMEOUT_MS}) throw new Error('fixed total cut');`],
  ['reintroduce an idle cut', '      const now = env.now();', `      const now = env.now(); if (now - lastSaveSeenAt >= ${OBSOLETE_SAVE_TIMEOUT_MS}) throw new Error('idle cut');`],
  ['sinceSaveMs never restarts', '        lastSaveSeenAt = env.now();', ''],
  ['sinceSaveMs restarts on live-pointer change', '        lastChangeAt = env.now();', '        lastChangeAt = env.now(); lastSaveSeenAt = env.now();'],
  ['onWaiting error propagates', '} catch (error) {}', '} catch (error) { throw error; }'],
  ['onWaiting not called', 'if (onWaiting) onWaiting({ waitedMs: now - (editedAt ?? started), sinceSaveMs: now - lastSaveSeenAt, saves });', ''],
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
