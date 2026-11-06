// Apply one plausible behavioral defect to a disposable copy; every mutant must fail tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MUTANT_TIMEOUT_MS = 30000;
const OBSOLETE_SAVE_TIMEOUT_MS = 60000;
const CORE_MUTANTS = [
  ['refuse account diagnosis', "if (selectedBackend === 'account') return await diagnoseAccount(env, storage, { signal, onProgress });", "if (selectedBackend === 'account') return { state: 'unsupported-backend', backend: 'account' }"],
  ['allow node backend', "if (env.isNode) return 'node';", ''],
  ['allow Tauri backend', "if (env.isTauri) return 'tauri';", ''],
  ['accept invalid index trash', '&& Array.isArray(value.entries) && Array.isArray(value.trash)', '&& Array.isArray(value.entries)'],
  ['drain non-index chat files', 'if (!INDEX_PREFIX.startsWith(prefix.slice(0, INDEX_PREFIX.length))) return null;', ''],
  ['offer dead pointer as candidate', 'if (id !== excludeId) {', 'if (true) {'],
  ['oldest candidate first', 'b.lastModified - a.lastModified', 'a.lastModified - b.lastModified'],
  ['hide missing large values', 'missingLarge: large.filter((entry) => !names.has(coldName(entry.l))).length', 'missingLarge: 0'],
  ['ignore changed pointer', "    const storage = liveStorage(env);\n    if (!storage) throw new FixError('NOT_BROKEN');\n    if (storage[POINTER_KEY] !== pointer) throw new FixError('CHANGED');", "    const storage = liveStorage(env);\n    if (!storage) throw new FixError('NOT_BROKEN');"],
  ['overwrite healthy storage', "if (current.state === 'healthy') throw new FixError('NOT_BROKEN');", ''],
  ['skip candidate revalidation', "if (candidate.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');", ''],
  ['mutate a copy instead of live object', 'storage[POINTER_KEY] = candidateId;', '({ ...storage })[POINTER_KEY] = candidateId;'],
  ['reset stores null instead of deleting', '    delete storage[POINTER_KEY];\n    return await waitForPersisted', '    storage[POINTER_KEY] = null;\n    return await waitForPersisted'],
  ['ignore OPFS database flag', "if (env.localStorage.getItem('opfs_flag!') === 'able' && env.opfsWritable) {", 'if (false) {'],
  ['ignore migrated marker', "!keys.includes(DATABASE_KEY) || await env.forage.getItem('migrated')", '!keys.includes(DATABASE_KEY)'],
  ['big-endian block lengths', 'getUint32(0, true)', 'getUint32(0, false)'],
  ['skip compressed block decoding', 'if (compression === 1) data = await readGzip(env, data);', ''],
  ['confirm memory rather than saved file', '        saved = await readAtLocation(env, location);', "saved = { format: 'risusave', hasBlock: true, pointer: liveStorage(env)?.[POINTER_KEY] ?? null };"],
  ['reread without backup gate', "const shouldRead = lastBackup > baseline && (location.kind === 'opfs' || newer || unknownRetries > 0);", 'const shouldRead = true;'],
  ['confirm unknown file as empty', '        saved = await readAtLocation(env, location);', "saved = await readAtLocation(env, location); if (saved.format === 'unknown') saved = { format: 'risusave', hasBlock: true, pointer: null };"],
  /* Gate x3 run 2: a snapshot stock replaced mid-read is re-read before the pre-edit check calls the profile unsettled. */
  ['pre-edit check never re-reads a replaced snapshot', 'read.replaced && attempt < SETTLED_READ_ATTEMPTS', 'false && attempt < SETTLED_READ_ATTEMPTS'],
  ['pre-edit re-read reuses the stale snapshot', 'throwIfCancelled(signal);\n      read = await readSaved(env, location);', 'throwIfCancelled(signal);'],
  ['pre-edit re-read without waiting for the save', '      await env.sleep(SETTLED_READ_RETRY_MS);\n', ''],
  ['every unreadable save file counts as replaced', "replaced: error?.name === 'NotReadableError'", 'replaced: true'],
  ['pre-edit re-reads without a bound', 'read.replaced && attempt < SETTLED_READ_ATTEMPTS', 'read.replaced'],
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
  ['onWaiting error propagates', "sinceSaveMs: now - lastSaveSeenAt, saves });\n      } catch (error) {}", "sinceSaveMs: now - lastSaveSeenAt, saves });\n      } catch (error) { throw error; }"],
  ['onWaiting not called', 'if (onWaiting) onWaiting({ waitedMs: now - (editedAt ?? started), sinceSaveMs: now - lastSaveSeenAt, saves });', ''],
];
/* Account guards are challenged independently of the unchanged web receipt. */
CORE_MUTANTS.push(
  ['account device gate bypass', "if (devicesClosed !== true) throw new FixError('DEVICES_NOT_CONFIRMED');", ''],
  ['account alternate auth guessed', "if (env.localStorage.getItem('ignoreRisuAuth') === 'true') throw new AccountIssue('account-auth-unknown');", ''],
  ['account ignores missing fetch', "selectedBackend === 'account' && typeof env.fetch !== 'function' ? 'fetch' : null", 'false ? \'fetch\' : null'],
  ['account fallback before cache token', "sources.push({ ...fallback, source: 'fallback' });", "sources.unshift({ ...fallback, source: 'fallback' });"],
  ['account never retries stale credential', "if (phase === 'scan') return response;\n        continue;", "if (phase === 'scan') return response;\n        throw new AccountIssue('account-login');"],
  ['account changes accepted token mid run', 'const sources = run.accepted ? [run.accepted] : run.sources;', 'const sources = run.sources;'],
  ['account ignores hub identity', "if (saved.accountId !== null && saved.accountId !== run.accepted.id) throw new AccountIssue('account-mismatch');", ''],
  ['account allows no block DB', "if (!saved.hasBlock) throw new Error('목차 블록 없음');", ''],
  ['account accepts wrong RISUSAVE magic', "if (!SAVE_MAGIC.every((byte, i) => magic[i] === byte)) throw new Error('알 수 없는 RISUSAVE');", ''],
  ['account empty gzip is not a storage block', "const storage = text === '' ? {} : JSON.parse(text);", 'const storage = JSON.parse(text);'],
  ['account parser drains chats', "if (!ended) await reader.cancel().catch(() => {});\n      reader.releaseLock();\n    }\n  }\n\n  async function accountSources", "reader.releaseLock();\n    }\n  }\n\n  async function accountSources"],
  ['account sends POST', "method: 'GET', cache: 'no-store', signal: requestSignal", "method: 'POST', cache: 'no-store', signal: requestSignal"],
  ['account permits cacheable reads', "method: 'GET', cache: 'no-store', signal: requestSignal", "method: 'GET', cache: 'default', signal: requestSignal"],
  ['account reuses DB URL', '|${env.randomId()}`', '|fixed`'],
  ['account sends cache date', "'x-risu-save-date': '0'", "'x-risu-save-date': '1'"],
  ['account trusts listed 404', "if (names.has(id)) throw new AccountIssue('account-unavailable', 404, 'index');", ''],
  ['account skips missing recheck delay', 'await run.env.sleep(HUB_MISSING_RECHECK_MS);', ''],
  ['account single 404 is proof', "if (second.state !== 'status' || second.status !== 404) {", 'if (false) {'],
  ['account drops healthy local fallback', "return local.state === 'healthy' ? { ...local, state: 'local-only' } : local;", "return local.state === 'healthy' ? { state: 'missing' } : local;"],
  ['account partial scan offers survivors', "if (item.state === 'status') throw new AccountIssue('account-unavailable', item.status, 'scan');", "if (item.state === 'status') continue;"],
  ['account scan starts excess requests', 'length: Math.min(HUB_SCAN_CONCURRENCY, ids.length)', 'length: ids.length'],
  ['account scan leaves active bodies running after failure', 'if (!failure) failure = error;\n          controller.abort();', 'if (!failure) failure = error;'],
  ['account candidates hide uncertain files', "if (item.state === 'uncertain') uncertainCount += 1;", ''],
  ['account candidates reverse flush order', 'b.flushedAt - a.flushedAt', 'a.flushedAt - b.flushedAt'],
  ['account candidates reverse key count ties', 'return b.keyCount - a.keyCount ||', 'return a.keyCount - b.keyCount ||'],
  ['account candidates reverse id ties', '(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)', '(a.id < b.id ? 1 : a.id > b.id ? -1 : 0)'],
  ['account candidates lose missing large references', 'missingLarge: largeRows.filter((item) => !names.has(item.l)).length', 'missingLarge: 0'],
  ['account preflight skips fresh settled check', "if (saved.pointer !== pointer) throw new FixError('NOT_SETTLED');", ''],
  ['account preflight skips complete scan', 'await accountBroken(run, pointer);\n        await scanHubCandidates(run, { excludeId: pointer, onProgress });', 'await accountBroken(run, pointer);'],
  ['account preflight ignores changed auth source', "if (!currentSources.some((item) => item.source === run.accepted.source && item.id === run.accepted.id && item.token === run.accepted.token)) {", 'if (false) {'],
  ['account edits uncertain pointer', "if (!['missing', 'unreadable'].includes(current.state)) throw new FixError('UNCERTAIN');", ''],
  ['account overwrites healthy hub index', "if (current.state === 'healthy' || current.state === 'local-only') throw new FixError('NOT_BROKEN');", ''],
  ['account skips candidate shape validation', "if (target.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');", ''],
  ['account edits a copied live store', 'if (recovering) storage[POINTER_KEY] = target;', 'if (recovering) ({ ...storage })[POINTER_KEY] = target;'],
  ['account reset writes null', 'else delete storage[POINTER_KEY];', 'else storage[POINTER_KEY] = null;'],
  ['account quiet window shortened', 'const ACCOUNT_SAVE_SETTLE_MS = STOCK_PLUGIN_FLUSH_DELAY_MS + STOCK_ACCOUNT_POST_SAVE_MS + STOCK_SAVE_IDLE_MS + SAVE_POLL_INTERVAL_MS;', 'const ACCOUNT_SAVE_SETTLE_MS = SAVE_SETTLE_MS;'],
  ['account quiet window ignores new live pointer', 'quietSince = env.now();', 'quietSince = startAt;'],
  ['account receipt skips hub backoff', 'if (newDate || settleRead || env.now() >= nextReadAt)', 'if (newDate || settleRead)'],
  ['account receipt delays settle read to backoff', 'if (newDate || settleRead || env.now() >= nextReadAt)', 'if (newDate || env.now() >= nextReadAt)'],
  ['account trusts cache instead of hub receipt', 'snapshot = await readHubDatabase(run);', "snapshot = await parseAccountSave(env, await env.accountCache.getItem(DATABASE_KEY), signal);"],
  ['account receipt trusts 303 as target', "if (response.status !== 200) {\n      await cancelBody(response);\n      throw new AccountIssue('account-unavailable', response.status, 'db');", "if (response.status === 303) { await cancelBody(response); return { pointer: liveStorage(run.env)?.[POINTER_KEY] ?? null, hasBlock: true }; }\n    if (response.status !== 200) {\n      await cancelBody(response);\n      throw new AccountIssue('account-unavailable', response.status, 'db');"],
  ['account target not reread at receipt', 'const fresh = await accountIndex(run, snapshot.pointer, false);', "const fresh = { state: 'healthy' };"],
  ['account gone target silently waits', "if (snapshot.pointer === target && ['missing', 'unreadable'].includes(fresh.state)) throw new FixError('TARGET_GONE');", ''],
  ['account successor accepts old dead pointer', 'else if (snapshot.pointer !== deadPointer)', "else if (typeof snapshot.pointer === 'string')"],
  ['account receipt ignores pointer movement during target read', '            sampleLive();\n            if (accepted && snapshot.pointer === quietPointer && readWindow === quietSince', '            if (accepted && snapshot.pointer === quietPointer && readWindow === quietSince'],
  ['account treats a present non-string identity as absent', 'account = { id: root.account?.id ?? null,', "account = { id: typeof root.account?.id === 'string' ? root.account.id : null,"],
  ['account hubRejecting shown before three saves', 'hubRejecting: rejected >= HUB_REJECT_HINT_SAVES', 'hubRejecting: rejected >= 2'],
  ['account hubRejecting never shown', 'hubRejecting: rejected >= HUB_REJECT_HINT_SAVES', 'hubRejecting: false'],
  ['account hubRejecting does not reset', 'if (newDate) rejected = snapshot.pointer === deadPointer ? rejected + 1 : 0;', 'if (newDate && snapshot.pointer === deadPointer) rejected += 1;'],
  ['account no-index skips authoritative hub read', "const pointer = typeof storage?.[POINTER_KEY] === 'string' ? storage[POINTER_KEY] : null;", "const pointer = typeof storage?.[POINTER_KEY] === 'string' ? storage[POINTER_KEY] : null; if (pointer === null) return { state: 'no-index', backend: 'account' };"],
  ['account no-index compares undefined with null', "(typeof livePointer === 'string' ? livePointer : null) !== pointer", 'livePointer !== pointer'],
  ['account sync outranks native profiles', "if (env.isTauri) return 'tauri';\n    if (env.isNode) return 'node';\n    if (env.localStorage.getItem('accountst') === 'able') return 'account';", "if (env.localStorage.getItem('accountst') === 'able') return 'account';\n    if (env.isNode) return 'node';\n    if (env.isTauri) return 'tauri';"],
  ['account keeps prior-account cached credentials', 'if (fallback && sources[0]?.id !== fallback.id) sources.length = 0;', ''],
  ['account post-edit failure loses applied flag', "if (applied && failure.code !== 'CANCELLED') failure.applied = true;", ''],
  ['account pre-edit errors claim applied', 'this.applied = false;', 'this.applied = true;'],
  ['account cancellation claims applied', "if (applied && failure.code !== 'CANCELLED') failure.applied = true;", 'if (applied) failure.applied = true;'],
  ['account recover loses scan progress', 'return await editAccount(env, { pointer, candidateId, signal, onWaiting, onProgress }, true);', 'return await editAccount(env, { pointer, candidateId, signal, onWaiting }, true);'],
  ['account reset loses scan progress', 'return await editAccount(env, { pointer, signal, onWaiting, onProgress }, false);', 'return await editAccount(env, { pointer, signal, onWaiting }, false);'],
  ['account repair scan drops progress', 'await accountBroken(run, pointer);\n        await scanHubCandidates(run, { excludeId: pointer, onProgress });', 'await accountBroken(run, pointer);\n        await scanHubCandidates(run, { excludeId: pointer });'],
  ['account cache parser copies into Blob', 'const stream = source instanceof Uint8Array ? new ReadableStream({\n      start(controller) { controller.enqueue(source); controller.close(); },\n    }) : source;', 'const stream = source instanceof Uint8Array ? new Blob([source]).stream() : source;'],
  ['account receipt accepts a read started before settling', '&& readStarted - quietSince >= ACCOUNT_SAVE_SETTLE_MS', ''],
  ['account receipt trusts a healthy local target copy', "if (!localFallback) return { state: 'missing' };", ''],
  ['account receipt uses constant retry spacing', 'backoff = Math.min(HUB_RECHECK_MAX_MS, backoff * 2);', 'backoff = HUB_RECHECK_BACKOFF_MS;'],
  ['account receipt retry spacing has no cap', 'backoff = Math.min(HUB_RECHECK_MAX_MS, backoff * 2);', 'backoff *= 2;'],
  ['account receipt retry spacing ignores new date', 'saveSeenAt = env.now();\n        backoff = HUB_RECHECK_BACKOFF_MS;', 'saveSeenAt = env.now();'],
  ['account post-scan skips settled recheck', 'await accountSettled(run, pointer);\n        await accountBroken(run, pointer);\n        if (recovering) await accountTarget(run, candidateId, pointer);', 'await accountBroken(run, pointer);\n        if (recovering) await accountTarget(run, candidateId, pointer);'],
  ['account post-scan skips broken recheck', 'await accountSettled(run, pointer);\n        await accountBroken(run, pointer);\n        if (recovering) await accountTarget(run, candidateId, pointer);', 'await accountSettled(run, pointer);\n        if (recovering) await accountTarget(run, candidateId, pointer);'],
  ['account post-scan skips target recheck', 'if (recovering) await accountTarget(run, candidateId, pointer);\n        const currentSources', 'const currentSources'],
  ['account parser accepts unknown compression', "else if (compression !== 0) throw new Error('알 수 없는 압축 형식');", ''],
);

/* The waiting line is the user's only view of a receipt that never gives up on its own (0.1.1). */
const UI_MUTANTS = [
  ['stall measured on waited time', 'let text = sinceSaveMs >= RPF_SAVE_STALL_HINT_MS', 'let text = waitedMs >= RPF_SAVE_STALL_HINT_MS'],
  ['stall hint never shown', 'let text = sinceSaveMs >= RPF_SAVE_STALL_HINT_MS', 'let text = false'],
  ['waiting line renders after close', 'if (isAborted() || waitedMs < RPF_SLOW_SAVE_NOTICE_MS) return;', 'if (waitedMs < RPF_SLOW_SAVE_NOTICE_MS) return;'],
  ['waiting line re-renders every poll', 'if (text !== shownText) {', 'if (true) {'],
  ['waiting line from the first poll', 'if (isAborted() || waitedMs < RPF_SLOW_SAVE_NOTICE_MS) return;', 'if (isAborted()) return;'],
  /* After-the-edit errors (0.2.0 review O2 + Astra delta): the panel must say the change is in the tab, for any error class. */
  ['applied honoured only for FixError', 'if (error && error.applied === true) {', 'if (isFixError && error.applied === true) {'],
  ['every repair error claims applied', 'if (error && error.applied === true) {', 'if (error) {'],
  ['applied error shows the core message', "const reason = RPF_APPLIED_REASON[code] || (isFixError ? '계정 서버에서 고친 결과를 확실하게 읽지 못했어요.' : fallbackText);", 'const reason = error.message;'],
  ['applied note dropped', 'text: `⚠ ${reason}\\n${RPF_APPLIED_NOTE}\\n${again}`', 'text: `⚠ ${reason}\\n${again}`'],
];
const SUITES = [
  { file: 'src/core.js', test: 'tests/core.test.cjs', mutants: CORE_MUTANTS },
  { file: 'src/ui.js', test: 'tests/ui.test.cjs', mutants: UI_MUTANTS },
];
const MUTANTS = SUITES.flatMap((suite) => suite.mutants.map((mutant) => [suite, ...mutant]));

/* Every needle must match its file exactly once BEFORE any mutant runs. A needle that a later source change made ambiguous
   used to abort the run only when its turn came (0.2.0 review round: twice, ~20 minutes in, one bad needle per run); this
   lists them all within a second. The per-mutant check below stays as the guard at the point of use. */
const ambiguous = MUTANTS.map(([suite, label, from]) => [suite, label, fs.readFileSync(path.join(ROOT, suite.file), 'utf8').split(from).length - 1])
  .filter(([, , count]) => count !== 1)
  .map(([suite, label, count]) => `  "${label}" matches ${suite.file} ${count} times`);
if (ambiguous.length) throw new Error(`every mutant needle must match exactly once:\n${ambiguous.join('\n')}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rpsf-mutants-'));
let survivors = 0;
try {
  for (const [suite, label, from, to] of MUTANTS) {
    const source = fs.readFileSync(path.join(ROOT, suite.file), 'utf8');
    if (source.split(from).length !== 2) throw new Error(`mutant "${label}" must match ${suite.file} exactly once`);
    const mutated = source.replace(from, to);
    new vm.Script(mutated, { filename: label });
    const dir = path.join(work, label.replace(/\W+/g, '-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, suite.file), mutated);
    fs.copyFileSync(path.join(ROOT, suite.test), path.join(dir, suite.test));
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(dir, suite.test)], {
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
