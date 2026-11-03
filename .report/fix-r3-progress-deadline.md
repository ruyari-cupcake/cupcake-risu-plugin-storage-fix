# Core fix spec — receipt deadline follows host save progress (0.1.1, owner go 2026-11-03 "응, 0.1.1로 고쳐줘")

## R32 — AMENDMENT (supersedes R31's idle limit; read this first)

**What R31 assumed:** a newer `dbbackup` is a progress signal fine-grained enough that 60 s without one means the host stopped.
**What the live timeline showed** (`RPF_BULK_MB=500 RPF_CPU_THROTTLE=8 reset-race`, 1 s sampler of the newest backup number):
after the edit NO newer backup appeared for ~80 s, yet following the advice ended healthy (the save landed later). Cause in stock
`ea61945`: the first plugin call after the reset loads the store, `migrateLegacy` moves leftover inline values into the new index,
and `onLegacyMigrated` sets `requiresFullEncoderReload` (`ts/process/coldstorage.svelte.ts` L677-681), so the NEXT host save
re-encodes the whole database (`ts/globalApi.svelte.ts` L423-430) — one save of 500 MB at 8× CPU took > 80 s. RisuAI exposes no
"saving" signal (the `risu-db` sessionID post comes after that re-encode; `saving.state` is not reachable), so ANY idle number is the
same defect with a bigger constant.

**R32 (replaces R31 items 1–3 and 6):**
1. `waitForPersisted` resolves on confirmation (R16 settle rule unchanged) or rejects `CANCELLED` when `signal` aborts (and the
   existing `requireWeb`/environment errors). It never gives up on its own: remove `SAVE_IDLE_TIMEOUT_MS` (constant + export),
   the `idleTimeoutMs` option (core, recover, reset), and the `SAVE_UNCONFIRMED` code + message — the replaced path is deleted,
   not kept as a fallback. Sleep is `SAVE_POLL_INTERVAL_MS`.
2. Keep `onWaiting({ waitedMs, sinceSaveMs, saves })` exactly as R31 item 5 (once per poll before the sleep, errors swallowed,
   `sinceSaveMs` restarts at each NEWER backup, never on a live-pointer change). The UI (`src/ui.js`, already updated by the
   orchestrator) shows the waited time after 10 s and, once `sinceSaveMs` ≥ 60 s, what to check plus the reload button, while the
   wait continues.
3. R16 item 4 stays reversed (continuous movement → keeps waiting, ends by abort).

**Tests:** every `SAVE_UNCONFIRMED` expectation becomes "never resolves, never throws on its own; abort → `CANCELLED`; the edit was
applied once, never replayed or reverted" — cover: no newer backup ever (far past 60 s of fake time), endless newer corrupt/unknown
saves, continuous pointer movement with saves, pointer moving without saves. `onWaiting.sinceSaveMs` grows past 60 000 with no
throw and drops after a newer backup. Existing settle/receipt tests keep passing (end long fake waits by abort where they used
`timeoutMs`/`idleTimeoutMs` to bound them).
**Mutants (all KILLED):** "reintroduce a fixed total cut" and "reintroduce an idle cut" (each must be killed by a long fake wait
that only accepts `CANCELLED`), "sinceSaveMs never restarts", "sinceSaveMs restarts on live-pointer change", "onWaiting not called",
"onWaiting error propagates"; drop the R31 idle mutants that no longer apply; keep every other mutant.
**Verification venue:** unchanged (build, test, mutate; live `reset` and `reset-race`). The orchestrator runs `receipt-stuck`, the
heavy 8× run and the full gate.

---

(R31 below is kept as the record of the first attempt.)

Base contract: `.report/core-contract.md`; round-1 spec `.report/fix-round1-core.md` (R1–R5, R14) and round-2 spec
`.report/fix-r2-settle.md` (R16 settle rule) stay in force EXCEPT R16 item 4, which this spec reverses (below).
Caller map: `.report/caller-map.md` (save-loop row).

## Observation (live, stock v2026.10.292, real 300/500 MB save files; README § 검증 table)

`waitForPersisted` gives up after a FIXED 60 s from the start of the wait (`DEFAULT_SAVE_TIMEOUT_MS`, `src/core.js:13`,
check at L514-515). Receipt time grows with database size and device speed: server CPU 5–9 s; 500 MB + a plugin write during
the receipt at 6× CPU throttle = 66 s from the click (wait ≈ 56 s, just under the limit); the same at 8× → `SAVE_UNCONFIRMED`
at 78 s although the host was still saving normally. Following the ⚠ advice ended healthy with the plugin's value intact, so
it is a false alarm, not a loss — but a fixed cut on a user wait that is still progressing is a defect.

## Required outcome (R31)

The receipt wait gives up ONLY when the host has stopped saving: no NEWER `database/dbbackup-<n>.bin` has appeared for
`SAVE_IDLE_TIMEOUT_MS` (60 000 ms). While new backups keep arriving the tool keeps waiting, however long that takes.

## Change (src/core.js)

1. Rename `DEFAULT_SAVE_TIMEOUT_MS` → `SAVE_IDLE_TIMEOUT_MS` (= 60000), with a comment that it is an IDLE limit (no new host
   save for this long), not a total limit. Export it under the new name (drop the old export).
2. Rename the option `timeoutMs` → `idleTimeoutMs` in `waitForPersisted`, `recover`, `reset` (and every test / mutant
   needle that embeds it — `tests/mutate.cjs:38-39` embed the destructuring string; keep those mutants working).
3. Progress = a NEWER backup number observed (`latest > lastBackup`). NOTHING else counts: a live-pointer change without a
   new backup means a plugin moved memory while the host is not saving — that is exactly the stuck case.
   The idle clock starts at `editedAt ?? started` and restarts at `env.now()` whenever a newer backup is observed.
   `SAVE_UNCONFIRMED` only when `env.now() - lastSaveSeenAt >= idleTimeoutMs`; the sleep is bounded by the remaining idle time.
4. **R16 item 4 is reversed:** a plugin that keeps moving the pointer while the host keeps saving no longer times out — the
   wait continues; it ends only through `signal` (`CANCELLED`, the panel's close button). Never a false ✅: the settle rule
   (R16 items 1–3, 5: persisted pointer == current live pointer, unchanged for `SAVE_SETTLE_MS`, IDB keeps the gated read)
   is untouched.
5. New option `onWaiting` on `waitForPersisted`, `recover`, `reset`: called once per poll iteration, just before the sleep,
   with `{ waitedMs, sinceSaveMs, saves }` (`waitedMs` = now − (editedAt ?? started); `sinceSaveMs` = now − last newer-backup
   time (or edit time); `saves` = count of newer backups observed since the baseline). Wrap the call: a throwing callback is
   swallowed (it must never abort or alter a receipt wait). Do not reuse the name `onProgress` (diagnose's `(done, total)`).
6. Message: `SAVE_UNCONFIRMED: '변경은 했지만, 리스가 1분 동안 새로 저장하지 않아서 저장 파일에 반영된 것을 확인하지 못했어요.'`
7. Return shape unchanged `{ confirmed: true, persistedPointer }`. Liveness of everything else unchanged.

## Must not change

`src/ui.js` (the orchestrator already passes `onWaiting` and updated its texts), `src/install.template.html`, `tests/live/*`,
`README.md`, `CHANGELOG.md`, `.report/*` other than this file. One-stored-value rule. No trailing `//` comments in `src/`
(bookmarklet parses with every newline deleted). Public names other than the two renames above.

## Tests (tests/core.test.cjs, fake env) — RED first against the current code where the behaviour changes

- Flip `settle continuous pointer movement times out …` (currently ~L1036): saves keep arriving and the pointer keeps moving
  → never confirms, never `SAVE_UNCONFIRMED`, even far past 60 s of fake time; ends only by abort → `CANCELLED`; the edit
  was applied once and never replayed or reverted.
- Live pointer moves every poll but NO newer backup appears → `SAVE_UNCONFIRMED` at exactly `idleTimeoutMs` after the edit.
- A newer backup arriving one poll before the idle limit restarts the clock; the following matching, settled save confirms
  (this is the test the old fixed deadline fails).
- A long receipt (fake time ≫ idle limit) with backups spaced < idle limit confirms.
- `onWaiting` receives increasing `waitedMs`, a `sinceSaveMs` that drops back after each newer backup, and `saves` counts;
  a callback that throws is ignored (the wait still confirms / still times out at idle).
- Every existing test stays green after the mechanical rename; adjust only timing where the new rule legitimately changes it
  and say which tests you touched and why. The exact-message assertion moves to the new text.

## Mutants (tests/mutate.cjs) — every one KILLED by an AssertionError

"idle clock never restarts" (= the old fixed deadline), "idle restarts on live-pointer change", "idle check removed",
"onWaiting error propagates", "onWaiting not called". Keep all existing mutants killed (update needles for the rename).
Do NOT add "idle from wait start instead of editedAt" — in recover/reset the wait begins right after the edit, so it is
near-equivalent and survives.

## Verification venue (report each as RUN/PASSED, or COULD NOT VERIFY HERE with the reason)

In `/home/cupcake/workspace/cupcake/cupcake-risu-plugin-storage-fix`:
`npm run build && npm test && npm run mutate` (every mutant KILLED), then
`STOCK_DIR=/home/cupcake/cpm-repro/stock-dist/v2026.10.292 PLAYWRIGHT_MODULE=/home/cupcake/workspace/cupcake/Playwright/workspace/node_modules/playwright node tests/live/drive.mjs reset-race bookmarklet`
and `… reset bookmarklet` — both must print PASS. The orchestrator runs the new stuck scenario, the heavy 8× run and the full
live gate afterwards.
