# Core contract — `src/core.js` (컵케익 리스 플러그인 저장소 고치기)

Owner decisions (2026-11-02): a bookmarklet like `cupcake-webrisu-backup-unlock` that repairs a
RisuAI profile stuck on `Failed to load plugin storage index`; **recovery first** (repoint to a
surviving index), reset (clear the dangling pointer) only when nothing survives.

All stock facts below were read from GitHub `kwaroran/RisuAI` HEAD `ea61945` (v2026.10.292).
Paths below are relative to `src/` of that checkout.

## Stock facts the tool relies on (cite these, do not re-derive differently)

1. `src/ts/process/pluginStorageStore.ts`: the database keeps only a pointer
   `db.pluginCustomStorage._coldpluginIndex = <cold id>`. `doLoad` (L169-222): pointer string →
   `backend.get(pointer)`; if the result is not an index (`isPluginStorageIndex`: object,
   `type === 'risu-plugin-storage-index'`, `Array.isArray(entries)`, `Array.isArray(trash)`) it throws
   `Failed to load plugin storage index` and `loaded` stays false, so EVERY later call re-runs doLoad.
   Pointer absent / not a string → empty index, success. Index shape:
   `{ type, version: 1, entries: [{k, s?: json-string, l?: cold id}], trash: [{id, at, index?}] }`,
   written by `doFlush` with a fresh `crypto.randomUUID()` id; JSON key order is `type, version, entries, trash`.
2. v3 plugins share ONE store — `apiV3/v3.svelte.ts:1318-1327` maps `pluginStorage.*` to the store
   with no per-plugin prefix. So "only the broken plugin's data" does not exist; the index is shared.
3. `src/ts/process/coldstorage.svelte.ts` `getColdStorageItem` (L43-132): returns `null` (never
   throws) for a missing/undecodable item on every backend. Web (not Tauri, not node, not account):
   OPFS root file `coldstorage_<id>.json`, content = fflate `compress` (= gzip) of `JSON.stringify(value)`.
   `listColdStorageItems` (L207-250) lists OPFS root entries named `coldstorage_*.json`.
4. Backend selection (`src/ts/storage/autoStorage.ts` Init L173-226, `src/ts/platform.ts` L19-20):
   - account mode when `localStorage.getItem('accountst') === 'able'` (cold items then live on the hub,
     and a hub non-200 silently falls back to local → null → the SAME error text: transient ≠ dead);
   - node server when `globalThis.__NODE__` is truthy (cold items on the server, auth = signed JWT);
   - Tauri when `window.__TAURI_INTERNALS__` is truthy;
   - otherwise web: database storage is OPFS (`OpfsStorage`: root file named hex(utf8(key))) when
     `localStorage['opfs_flag!'] === 'able'` and the localforage DB `risuai` has no
     `database/database.bin` or has `migrated` truthy; else localforage IndexedDB database `risuai`,
     object store `keyvaluepairs`, value = Uint8Array.
5. `src/ts/plugins/plugins.svelte.ts`: `globalThis.__pluginApis__ = getV2PluginAPIs()` runs in
   `loadV2Plugin` (L867), called from `loadPlugins()` at every boot (`bootstrap.ts:213`) even with
   no v2 plugins. `__pluginApis__.getDatabase()` (L671-713) returns a Proxy; `pluginCustomStorage` is
   in `allowedDbKeys` (L469-494), so `getDatabase().pluginCustomStorage` is the LIVE `$state` object
   (`DBState.db.pluginCustomStorage`, the same object the store reads). Property set/delete on it
   works (only the outer proxy denies deleteProperty).
6. Saving (`src/ts/globalApi.svelte.ts` saveDb L293-500): an `$effect` on
   `$state.snapshot(DBState.db.pluginCustomStorage)` marks the block dirty and debounces 500 ms; the
   loop then writes `database/database.bin` and, when not account, `database/dbbackup-<round(Date.now()/100)>.bin`.
   Saved file (`src/ts/storage/risuSave.ts` encode/decode L300-500): `"RISUSAVE\0"` (9 bytes) then
   blocks `[type u8][compression u8][nameLen u8][name][length u32 little-endian][data]`;
   plugin storage = type 11, name `pluginStorage`, data = `JSON.stringify(pluginCustomStorage)`
   (gzip when compression byte is 1).

## API (exported object `RisuPluginStorageFix`; DOM-free; every browser API comes through `env`)

`src/core.js` defines `const RisuPluginStorageFix = (() => { ... })();` and ends with the line
`if (typeof module !== 'undefined') module.exports = RisuPluginStorageFix; // @strip-in-bundle`
(the build drops lines containing `@strip-in-bundle`; no other trailing `//` comments anywhere,
the bookmarklet must parse with every newline removed).

- `createBrowserEnv(globalObj = globalThis)` → env built from real APIs:
  `{ pluginApis(), localStorage, isNode, isTauri, opfsRoot(), forage: {keys(), getItem(key)} (raw
  IndexedDB `risuai`/`keyvaluepairs`, read-only, never creates the DB: if opening triggers
  `onupgradeneeded`, abort and treat as empty), gunzip(Blob|Uint8Array) via DecompressionStream('gzip'),
  now(), sleep(ms) }`. Tests pass their own fake env with the same shape. Account mode additionally uses
  `fetch(url, init)` (bound to the injected global), read-only `accountCache: {keys(), getItem(key)}`
  (`risuaiAccountCached` / `keyvaluepairs`, abort missing-DB upgrades), `randomId()` (crypto.randomUUID),
  and `hubBase()` (read current `localStorage.hub`: nightly → `https://nightly.sv.risuai.xyz`, else
  `https://sv.risuai.xyz`). All adapters are lazy; web operations never access accountCache or fetch.
- `FixError` (code + Korean message), codes at least: `NOT_RISU`, `NOT_READY`, `UNSUPPORTED_BACKEND`,
  `NOT_BROKEN`, `CHANGED` (live pointer differs from the diagnosed one), `CANDIDATE_INVALID`,
  `CANCELLED` (0.1.1 removed `SAVE_UNCONFIRMED`: the receipt never gives up on its own, R32).
- `async diagnose(env, {signal, onProgress})` → one of
  - `{ state: 'not-risu' }` — no `__pluginApis__`/`getDatabase`;
  - `{ state: 'not-ready' }` — `getDatabase().pluginCustomStorage` missing/not an object;
  - `{ state: 'unsupported-backend', backend: 'node'|'tauri' }` — decided BEFORE touching storage;
  - `{ state: 'no-index', backend: 'web' }` — pointer not a string (healthy: nothing stored yet);
  - `{ state: 'healthy', backend: 'web', pointer, keyCount }` — pointer file exists and parses as an index;
  - `{ state: 'broken', backend: 'web', pointer, reason: 'missing'|'unreadable', candidates }` —
    `missing` = no `coldstorage_<pointer>.json` in OPFS; `unreadable` = file exists but gunzip/JSON/
    `isPluginStorageIndex` fails. `candidates` = `findCandidates` result excluding the pointer.
- `async findCandidates(env, {excludeId, signal, onProgress})` → array sorted newest first by
  `File.lastModified`, each `{ id, lastModified, keyCount, sampleKeys (first 8 keys), largeCount,
  missingLarge (count of `l` ids with no OPFS file) }`. Scan every `coldstorage_*.json` root entry;
  to stay cheap on big chat items, stream-gunzip and read only until the prefix decides: keep a file
  only if its JSON starts with `{"type":"risu-plugin-storage-index"`, then fully parse and require
  `isPluginStorageIndex`. Unreadable files are skipped, never thrown. Report progress `(done, total)`.
- `async recover(env, {pointer, candidateId, signal, onWaiting})` — re-checks: backend web, live
  pointer still `=== pointer` (else `CHANGED`), live pointer still broken (else `NOT_BROKEN`),
  candidate re-read and valid (else `CANDIDATE_INVALID`); then sets
  `pluginCustomStorage._coldpluginIndex = candidateId` and returns `await waitForPersisted(...)` for
  pointer `=== candidateId`.
- `async reset(env, {pointer, signal, onWaiting})` — same re-checks (no candidate); then
  `delete pluginCustomStorage._coldpluginIndex` and waits for the persisted pointer to be absent.
  Touches NOTHING else: other `pluginCustomStorage` keys (legacy inline values, `_coldplugin` map),
  cold storage files, safeLocalStorage, IndexedDB plugin stores all stay as they are.
- `async readPersistedPointer(env)` → `{ format: 'risusave', hasBlock, pointer: string|null }` or
  `{ format: 'unknown' }` (no DB / not `RISUSAVE\0`). Reads the database from the location rule in
  fact 4. On OPFS read lazily through `File.slice` (headers only, plus the pluginStorage block); on
  IndexedDB the value is already a Uint8Array.
- `async waitForPersisted(env, predicate, {signal, onWaiting})` — cheap gate
  first: list database keys (`forage.keys()` or OPFS hex names) and only re-read the database when a
  `database/dbbackup-<n>.bin` newer than the last one seen appears (plus one initial read); resolve
  `{ confirmed: true }` when `predicate(pointer)` holds on the persisted file (and the R16 settle rule,
  `fix-r2-settle.md`). Never gives up on its own (0.1.1, R32 `fix-r3-progress-deadline.md`: one stock save
  can take minutes and RisuAI exposes no saving signal); ends only on `signal` (`CANCELLED`). `onWaiting`
  gets `{waitedMs, sinceSaveMs, saves}` each poll (`sinceSaveMs` restarts on a newer backup); its errors are
  swallowed. Tunables are named constants.

## Account API (design r1; stock v2026.10.294)

Authority: `account-mode-design.md` r1 and `account-mode-review/05-sol-spec.md`. The stock account save
writes cache bytes and `database/database.bin__date` even when the hub rejects the save
(`src/ts/storage/accountStorage.ts:23-95`); neither is a receipt. The cache root supplies the first token
source, fallbackRisuToken the second; only an initial 403 advances to the next source. Accepted identity
and hub remain bound to the run. Credential IDs remain strings; a present hub root ID of any type
must match that accepted string exactly (non-string IDs are mismatches, not absent identities).
ignoreRisuAuth=true refuses diagnosis/edits without guessing an auth method.

- `backend(env)` exposes the existing selection order: account, node, tauri, web.
- `diagnose` in account mode requires OPFS, DecompressionStream and fetch. All account-specific results
  carry `backend: 'account'`: `no-index`; `healthy {pointer,keyCount}`; `local-only {pointer,keyCount}`;
  `account-login`; `account-auth-unknown`; `account-mismatch`; `account-not-settled {pointer}`;
  `account-unavailable {status: number|null, phase: 'db'|'index'|'list'|'scan'}`; `uncertain {pointer}`;
  `broken {pointer,reason:'missing'|'unreadable',candidates,uncertainCount}`. Shared not-risu/not-ready and
  unsupported-browser retain their meaning. No account/root credentials are returned.
- Every request is GET, no-store, x-risu-auth, and a run AbortSignal. DB reads use a fresh UUID suffix,
  x-risu-save-date=0 and x-risu-key=database/database.bin. The incremental RISUSAVE reader shares the
  byte-array/cache and streaming/hub format rule: ROOT=1/name=root for account.id (token only for local
  credential selection), PLUGIN_STORAGE=11/name=pluginStorage for the pointer. It handles split headers
  and lengths, gzip and an empty gzip payload (hasBlock=true, pointer=null), rejects truncation, skips
  other blocks, and cancels immediately after pluginStorage, before characters/chats.
- R2: a 200 index must decode and match the unchanged stock acceptance rule; gzip failures are uncertain,
  JSON/shape failures unreadable. Missing requires 404, absence from @list-keys, then another 404 at least
  HUB_MISSING_RECHECK_MS=2000 later. Listed/reappearing items are unavailable, never missing. A healthy
  OPFS fallback yields local-only, not authority to repair. Hub receipt validation never uses that fallback.
- R4: every listed key except the pointer is scanned, with at most HUB_SCAN_CONCURRENCY=4 streams; the
  prefix rejects non-index items early. Any listed non-200 (404/403/429/5xx included) aborts the complete
  scan and queued/in-flight work, without retries or offering repair. Candidate fields are
  `{id,flushedAt:number|null,keyCount,sampleKeys,largeCount,missingLarge}`; flushedAt is the maximum finite
  index:true trash timestamp, missingLarge uses the complete hub key set. Sort flushedAt descending (null
  last), keyCount descending, then id ascending. findCandidates remains an array-returning API.
- `recover` / `reset` add `devicesClosed`. In account mode strict true is required before any database/cache
  or network read; web mode ignores it. Both recheck the live pointer, fresh hub pointer/identity, R2
  brokenness, complete scan and accepted credential source across awaited preflight reads. recover also
  rereads its hub candidate. They perform exactly one live property set/delete and never replay or undo it.
  New Korean FixError codes: DEVICES_NOT_CONFIRMED, ACCOUNT_LOGIN, ACCOUNT_UNAVAILABLE, ACCOUNT_MISMATCH,
  TARGET_GONE. Existing NOT_SETTLED, CHANGED, NOT_BROKEN, CANDIDATE_INVALID, UNCERTAIN and CANCELLED apply.
  Auth-unknown repair refusal uses UNCERTAIN. Error messages never include transport errors, tokens or root fields.
- Receipts resolve `{confirmed:true,persistedPointer}` only after the live pointer is quiet for
  ACCOUNT_SAVE_SETTLE_MS=1000+3000+500+500=5000 (stock plugin flush, account post-save sleep, save idle,
  poll), then a newly requested hub DB matches it and a fresh hub target/successor is valid. A proven gone
  original target raises TARGET_GONE, leaving the edit in place; unverifiable successors keep waiting.
  Each 500ms poll reads only the cache date. New dates, quiet-window close, and unresolved backoff
  (2000ms doubling to 60000ms, reset on new dates) trigger fresh DB reads. A 303 never confirms. No receipt
  deadline exists; only explicit cancellation ends an unresolved wait. Account onWaiting adds hubRejecting
  after three consecutive new dates whose fresh hub read retains the dead pointer, resetting on other or
  unavailable snapshots. The unchanged web callback omits this account-only flag (treated as false by UI).
  Throwing display callbacks cannot stop a receipt or replay an edit.

## Outcome contract

On stock RisuAI v2026.10.292 web (IndexedDB or OPFS database), a profile whose
`_coldpluginIndex` points at a missing/unreadable cold item: after `recover` (when a surviving index
exists) the persisted database points at that index and a reload makes every
`risuai.pluginStorage` call succeed with the recovered keys; after `reset` the persisted database has
no pointer and a reload makes every call succeed on an empty store. A healthy profile is never
changed. Node / Tauri profiles are never changed. In account sync mode, diagnosis uses the account hub
rather than the local fallback to distinguish transient failures, local-only data and genuinely broken
indexes. A complete hub scan may authorize a single live pointer repair, but success requires a FRESH
hub database read after settling and a fresh readable hub index (or an absent pointer after reset).
Uncertain/partial preflight situations change nothing. Unit fixtures verify the protocol/state machine
and exact simulated hub reopen, not actual stock browser persistence or multi-device sync; the live
account scenarios remain a separate release gate.

## Preservation contract

Never write, delete or rename any cold storage file, database file, IndexedDB record, localStorage
key or plugin key other than the single `_coldpluginIndex` property. Never create the `risuai`
IndexedDB database or `risuaiAccountCached`. In web mode never send anything over the network and never
open the account cache. In account mode only GET the stock hub endpoints using the stock-kept login;
never POST, remove, write, delete or create remote/local storage. Preserve all non-pointer fields,
object identities, cold item contents and database blocks. The shared stock index acceptance rule
remains owned by isPluginStorageIndex; neither transport introduces a stricter or broader format.

## Tests (`tests/core.test.cjs`, `node --test`, no dependencies, Node ≥ 20)

Fixtures are built with `node:zlib` gzip (independent from the tool's DecompressionStream path) and a
fake env (fake OPFS directory/file handles with `lastModified`, fake forage, fake `__pluginApis__`
with a live object, fake clock/sleep, a fake "saver" that writes a RISUSAVE file when told). Cover at
least: each diagnose state; candidate ordering/filtering (non-index items, a chat item whose JSON
merely contains the index type string later, corrupt gzip, the dead pointer itself excluded, missing
large count); recover/reset re-check refusals (`CHANGED`, `NOT_BROKEN`, `CANDIDATE_INVALID`);
reset leaves every other key untouched; persisted-pointer parsing on both locations incl. a
compressed block, other blocks before it, and a non-RISUSAVE file; wait gating (no re-read without a
new dbbackup key; a stale in-flight save that still has the old pointer does NOT confirm; no save → keeps
waiting (0.1.1, R32); abort → `CANCELLED`). `tests/mutate.cjs` (same style as
`cupcake-webrisu-backup-unlock/tests/mutate.cjs`): at least 8 plausible-bug mutants, every one KILLED.
