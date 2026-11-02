# Core fix spec — settled save receipt (live gate 2026-11-03, `reset-race` → `RACED_VALUE_LOST`)

Base contract: `.report/core-contract.md`; round-1 core spec: `.report/fix-round1-core.md` (R1–R5, R14 stay in force).
Caller map (read first, answer every row): `.report/caller-map.md`.

## Observation (live, stock v2026.10.292 = GitHub `ea61945`, IndexedDB database, bookmarklet form)

Record: `tests/live/work/result-reset-race-bookmarklet.json`.
Seeded store with a legacy inline key → cold files deleted → dead state → tool reset → right after the live pointer cleared, the
probe plugin wrote `raced = 'during-confirmation'` (19:38:55.39Z) → tool showed ✅ (56.70Z) → the driver pressed the panel's
"지금 새로고침" immediately → after reload the pointer was a new valid id whose index has the legacy key but `raced` is `null`.

Stock mechanics (cite and re-verify yourself against a `git clone` of `kwaroran/RisuAI` at HEAD `ea61945`):
- First plugin call after the edit: `load` → `doLoad` (pointer absent → empty) → `migrateLegacy` → immediate `flush` → index S1
  (legacy key only), live pointer = S1 (`ts/process/pluginStorageStore.ts` L169-222, commit L474-496).
- The call's own value is only `markDirty` → `scheduleFlush(flushDelay)`; it lands in the NEXT index S2 ≈ 1 s later
  (L372-402, L502-519; `flushDelay: 1000` L56; +1 s per 512 KB of index, capped by `maxFlushDelay: 15000` L57).
- The host saves the database ~500 ms after a change at the earliest (`ts/globalApi.svelte.ts` L412-416 idle sleep, write L466-470).
- Unload is best effort only (`ts/process/coldstorage.svelte.ts` L684-692): a pointer moved during unload is not saved.

Diagnosis (orchestrator; verify, do not take on trust): the receipt accepted the persisted S1 as a verified successor while the
live pointer was already S2 (or would be within the store's flush delay). ✅ therefore came before the database held the store's
current state, and the immediate reload discarded S2.

## Required outcome

✅ (the resolved `recover`/`reset` promise) means: the saved database holds the live store's CURRENT index pointer, and that
pointer has stopped moving long enough that a plugin write made together with the store's last pointer change has been flushed
and saved. Pressing reload immediately after ✅ must not lose a plugin write that happened between the edit and ✅.

## Change (src/core.js `waitForPersisted` and its two callers)

1. Confirm only when ALL hold on the same poll:
   - existing gates (strictly newer backup than the pre-edit baseline, `risusave` + `hasBlock`, acceptance predicate = target or
     verified successor, cancellation, `requireWeb`);
   - the persisted pointer equals the CURRENT live pointer read from `liveStorage(env)` on that poll, with absent normalized:
     a deleted key reads `undefined` live, the saved block reports `null` — they must compare equal;
   - the live pointer has been unchanged for at least `SAVE_SETTLE_MS`, measured from the last poll that observed a change (the
     edit itself counts as a change at edit time).
2. `SAVE_SETTLE_MS` is a named constant composed from named stock-derived constants with a comment citing the stock lines above
   (base flush delay 1000 ms + host save idle 500 ms + one tool poll interval). It must be ≥ 2000 ms. Do not try to model the
   size-dependent flush delay; that residual is documented, not engineered.
3. IndexedDB location: a read that matched the pointer but was taken before the settle elapsed must still be able to confirm
   once the settle elapses even if no newer backup arrives (the host stops saving when nothing changes) — e.g. keep the last
   successful read until a newer backup supersedes it. OPFS keeps re-reading every poll (round-1 rule: `close()` not awaited).
4. Liveness: a plugin that keeps moving the pointer faster than the settle window ends in the existing `SAVE_UNCONFIRMED`
   timeout. Keep the timeout and its message.
5. Return shape unchanged: `{ confirmed: true, persistedPointer }`.

## Must not change

Public API names/shapes used by `src/ui.js` (`diagnose`, `recover`, `reset`, `findCandidates`, `readPersistedPointer`,
`waitForPersisted`, `FixError` codes, result fields). The one-stored-value rule (the tool writes only
`pluginCustomStorage._coldpluginIndex` on the live object). No trailing `//` comments in `src/` (the bookmarklet must parse with
every newline deleted). Do not edit `src/ui.js`, `src/install.template.html`, `README.md`, `CHANGELOG.md`, `tests/live/*`,
`.report/core-contract.md`, `.report/caller-map.md`.

## Tests (tests/core.test.cjs, fake env) — RED first against the current code, then GREEN

- Reproduce: persisted S1 (verified successor) while live moved to S2 → must NOT confirm; confirms only after S2 is persisted
  and settled; `persistedPointer === S2`.
- Persisted == live == S1 read BEFORE the settle elapsed, then live moves to S2 inside the window → must not confirm on S1.
- Plain reset with no plugin activity: live `undefined`, saved `null` → confirms after the settle (no timeout).
- IndexedDB: matching read before settle, no newer backup afterwards → confirms once settled.
- Recover: live = candidate, persisted = candidate → confirms only after the settle.
- Continuous pointer movement → `SAVE_UNCONFIRMED`.
- Existing 97 tests stay green (adjust only timing in fakes where the settle legitimately delays a confirmation; never weaken
  an assertion — say which tests you touched and why).

## Mutants (tests/mutate.cjs) — every one KILLED by an AssertionError

"skip settle", "settle 0", "ignore live pointer", "treat undefined ≠ null", "settle from wait start instead of last change",
"IDB: drop matched read before settle" (or the equivalent for your design).

## Verification venue (report each as RUN/PASSED, or COULD NOT VERIFY HERE with the reason)

In the repository root:
`npm run build && npm test && npm run mutate`, then the live scenario
`STOCK_DIR=<stock dist> PLAYWRIGHT_MODULE=<playwright> node tests/live/drive.mjs reset-race bookmarklet`
and `… node tests/live/drive.mjs reset bookmarklet` (both must print PASS; the driver's immediate panel reload is the adversarial
case — do not add waits to the driver). The orchestrator runs the full gate afterwards.
