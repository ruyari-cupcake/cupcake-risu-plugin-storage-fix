# Core fix spec — round 1 (src/core.js + tests)

Source of truth for WHY: the maintainer's round-1 review synthesis (accept/reject rows R1–R15; not in this repo)
(accepted rows R1–R5, R14 concern core/tests; the UI rows are done separately by the orchestrator).
Base contract stays `.report/core-contract.md`; this file only lists what changes.

## R1 — save receipt soundness (`recover`, `reset`, `waitForPersisted`)

1. Before mutating (inside recover/reset, after the existing re-checks): read the persisted pointer.
   Require `format === 'risusave' && hasBlock && pointer === <live dead pointer>`; otherwise throw
   `FixError('NOT_SETTLED')` with a Korean message telling the user to close other Risu tabs, reload, and run
   the tool again. Nothing is mutated in that case.
2. Capture the receipt baseline (newest `database/dbbackup-<n>.bin` number at the chosen location) BEFORE the
   edit, and pass it to the wait. The wait never confirms from any read taken before a backup strictly
   newer than that baseline has appeared.
3. After the first newer backup has appeared:
   - OPFS database location: re-read `database.bin` on EVERY poll until confirmed or timed out (stock
     `OpfsStorage.setItem` does not await `close()`, so the name of a newer backup is not a commit receipt).
   - IndexedDB location: read once per newer backup; if that read returns `format: 'unknown'`, retry on the
     next polls (bounded by a named constant) before waiting for another backup.
4. Acceptance predicate (shared helper): the persisted pointer equals the target (recover: candidate id;
   reset: absent), OR it is a VERIFIED SUCCESSOR: a string that is not the dead pointer and whose OPFS
   `coldstorage_<id>.json` reads as `healthy` with the same `readIndex` path. Reset may confirm with an
   absent pointer or a verified successor; recover with the candidate or a verified successor.
   Return `{ confirmed: true, persistedPointer }` (`persistedPointer` = the id seen, or `null`).
5. Keep: `hasBlock` requirement, cancellation, timeout `SAVE_UNCONFIRMED`, refusal of non-web backends.

## R2 — three-way index classification (`readIndex`, `diagnose`, `findCandidates`, re-checks)

- `missing`: `getFileHandle` rejects with `NotFoundError` (only this).
- `unreadable`: the file decoded completely (gzip OK) but `JSON.parse` fails or the value fails the stock
  index shape check — stock `getColdStorageItem` + `isPluginStorageIndex` fail identically.
- `uncertain`: everything else — `getFile`/stream read errors (any DOMException other than NotFoundError on
  the handle), decompression failures (stock uses fflate, which is more lenient than `DecompressionStream`,
  e.g. a bad CRC), `TypeMismatchError`, unknown errors. Cancellation still throws `CANCELLED`.
- `diagnose`: pointer `uncertain` → `{ state: 'uncertain', backend: 'web', pointer, accountHint }`, no candidate
  scan, nothing mutable. Pointer `missing`/`unreadable` → `broken` as today, plus `uncertainCount` = candidate
  files that classified `uncertain` (skipped as candidates).
- recover/reset re-check: proceed only when the live pointer still classifies `missing` or `unreadable`;
  `healthy` → `NOT_BROKEN`; `uncertain` → `FixError('UNCERTAIN')` (Korean: the tool could not read the file
  reliably, nothing changed, close other tabs/reload and retry).

## R3 — capabilities

- `createBrowserEnv` exposes `hasOpfs` (`typeof navigator.storage?.getDirectory === 'function'`),
  `hasDecompression` (`typeof DecompressionStream === 'function'`), `opfsWritable`
  (`typeof FileSystemFileHandle?.prototype?.createWritable === 'function'`), all as getters on `globalObj`.
- `diagnose` (after the backend check): missing OPFS or decompression → `{ state: 'unsupported-browser', backend: 'web', missing: 'opfs' | 'decompression' }`.
  recover/reset/findCandidates throw `FixError('UNSUPPORTED_BROWSER')` in the same case.
- `databaseLocation`: OPFS only when `opfs_flag! === 'able'` AND `env.opfsWritable` AND (no IDB database key
  OR `migrated`) — mirrors stock `autoStorage.ts` Init L185-200.

## R4 — never-used plugin storage

`liveStorage`/`diagnose`: if `getDatabase()` returns a loaded database (its `plugins` is an array) but
`pluginCustomStorage` is absent or not an object → `{ state: 'no-index', backend }` (after the backend check),
not `not-ready`. `not-ready` only when the database itself is not loaded. recover/reset in that case:
`NOT_BROKEN`.

## R5 — account hint

`diagnose` adds `accountHint: env.localStorage.getItem('dosync') === 'avoid'` to `broken` and `uncertain`
results (stock sets it on account logout and when account sync is declined — accountStorage.ts:217,
autoStorage.ts:79,89). Pure information; no behaviour change in core.

## R14 — bundle parse

`tests/core.test.cjs` already checks core alone after newline removal — make sure it checks DELETION
(`replace(/\n/g, '')`) as well as replacement by spaces. (tests/bundle.test.cjs is the orchestrator's.)

## Tests + mutants

Extend `tests/core.test.cjs` (Node, fake env) so each item above has a RED-able assertion, including:
initially-matching disk + delayed stale write must NOT confirm (and NOT_SETTLED when disk ≠ live dead pointer);
OPFS backup-name-before-commit → still confirms once the bytes land within the timeout; IDB transient
`unknown` then good read → confirms; successor accepted only when its file is a valid index (a successor id
with no file, or the dead id, never confirms); `uncertain` from a getFile error and from a bad-CRC gzip that
`node:zlib` can still inflate leniently → no mutation possible; `unreadable` (valid gzip, bad JSON / wrong
shape) → reset allowed; unsupported-browser states; never-used storage → no-index; accountHint pass-through.
Add mutants to `tests/mutate.cjs` for each new guard; every mutant must be KILLED by an AssertionError.
