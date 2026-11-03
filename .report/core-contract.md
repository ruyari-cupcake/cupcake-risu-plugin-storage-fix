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
  now(), sleep(ms) }`. Tests pass their own fake env with the same shape.
- `FixError` (code + Korean message), codes at least: `NOT_RISU`, `NOT_READY`, `UNSUPPORTED_BACKEND`,
  `NOT_BROKEN`, `CHANGED` (live pointer differs from the diagnosed one), `CANDIDATE_INVALID`,
  `CANCELLED` (0.1.1 removed `SAVE_UNCONFIRMED`: the receipt never gives up on its own, R32).
- `async diagnose(env, {signal, onProgress})` → one of
  - `{ state: 'not-risu' }` — no `__pluginApis__`/`getDatabase`;
  - `{ state: 'not-ready' }` — `getDatabase().pluginCustomStorage` missing/not an object;
  - `{ state: 'unsupported-backend', backend: 'account'|'node'|'tauri' }` — decided BEFORE touching storage;
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

## Outcome contract

On stock RisuAI v2026.10.292 web (IndexedDB or OPFS database), a profile whose
`_coldpluginIndex` points at a missing/unreadable cold item: after `recover` (when a surviving index
exists) the persisted database points at that index and a reload makes every
`risuai.pluginStorage` call succeed with the recovered keys; after `reset` the persisted database has
no pointer and a reload makes every call succeed on an empty store. A healthy profile is never
changed. Account / node / Tauri profiles are never changed.

## Preservation contract

Never write, delete or rename any cold storage file, database file, IndexedDB record, localStorage
key or plugin key other than the single `_coldpluginIndex` property. Never create the `risuai`
IndexedDB database. Never send anything over the network.

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
