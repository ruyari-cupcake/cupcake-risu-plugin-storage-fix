# Fix spec — storage-fix 0.2.0 review findings (core + unit tests + mutants)

Base: commit `a4abb49` (gated: unit 201/201, mutants 116/116, live 17/17). Findings + evidence: `14-synthesis.md`.
Caller map: `15-caller-map.md`. Design r1 `../account-mode-design.md`, contract `../core-contract.md`.
Stock v2026.10.294 sources: `/tmp/claude-1000/-home-cupcake-workspace-cupcake/73043374-ee52-4fa0-b757-a28094c44049/scratchpad/v294/`.

## Ownership fences
- You own: `src/core.js`, `tests/core.test.cjs`, `tests/mutate.cjs`, `.report/core-contract.md`, a short r2 note in
  `.report/account-mode-design.md` (only for C4's terminal cases), and `dist/` via `npm run build`.
- Never edit: `src/ui.js`, `tests/ui.test.cjs`, `tests/live/**`, README/CHANGELOG, anything outside this repo. The orchestrator
  edits `src/ui.js` against the interface pinned below (it may change while you work; if `tests/ui.test.cjs` fails on a
  ui.js line, report it, do not touch ui.js).
- No live runs, no network, no Playwright, never read `~/.config/cpm-secrets/` or any `*.env`. No commits, tags or pushes.

## Pinned interface (the orchestrator's ui.js relies on exactly this)
- S1 adds NO new state: account `no-index` / `account-not-settled` (existing fields).
- S2 uses the existing `unsupported-backend` result (`backend: 'tauri'|'node'`) and `FixError('UNSUPPORTED_BACKEND')` from
  recover/reset.
- C4: `FixError` gains a boolean `applied`; `true` exactly on errors that escape AFTER the live pointer edit.
- C5: `recover(env, {…, onProgress})` and `reset(env, {…, onProgress})` accept `onProgress(done, total)` with the same
  shape diagnose's scan uses; web mode ignores it.

## Changes
C1 (S1, false ✅) — account `no-index` must come from the hub. When the live storage has no string pointer, run the
account read like the pointer branch: hub DB read with the usual identity binding; hub pointer is a string → 
`account-not-settled`; hub has the block and no pointer, and live still has none → `no-index`; read failures → the usual
account-* states (never `no-index`). TRAP: normalize the live pointer to `string|null` BEFORE comparing — `storage` may be
`undefined` (no `pluginCustomStorage`) and `undefined !== null` must not become a false not-settled. Rewrite the test at
`core.test.cjs:1386` (it pins zero requests today). Mutant: restore the pre-read shortcut → must die.

C2 (S2) — `backend(env)` order: Tauri → Node → account → web. Stock Tauri writes the DB to AppData even with
`accountst=able` (`src_ts_globalApi.svelte.ts:455-470`); Node stays refused per the contract ("Node / Tauri profiles are
never changed"). Tests: each of `isTauri`/`isNode` with `accountst=able` → diagnose `unsupported-backend`, recover/reset
`UNSUPPORTED_BACKEND`, and ZERO `fetch` + ZERO `accountCache` access. Mutant: swap the order back → must die.

C3 (O1) — stale cache from another account. Stock Logout (`unMigrationAccount`, `src_ts_storage_accountStorage.ts:194-221`)
never clears `risuaiAccountCached`, and a 200 read never writes it (`:102-166`). In `accountSources`, when
`fallbackRisuToken` parses to credentials whose `id` differs from the cache root's `id`, drop the cache source. Both
callers (run start, pre-edit re-check) must apply the same rule. Test: cache root = A (with token), fallback = B → only B's
token is ever sent, identity binds to B. Mutant: keep the cache source → must die.

C4 (O2) — post-edit terminal errors. Every error escaping `waitForAccountPersisted` after the live edit (enumerate them in
your report: CHANGED, TARGET_GONE, ACCOUNT_LOGIN, ACCOUNT_MISMATCH, UNCERTAIN path if reachable, any other) gets
`applied: true` (after `accountError` mapping); pre-edit errors never do; `CANCELLED` (explicit abort) is unchanged.
Transient hub failures keep waiting as today. Align `core-contract.md` (`:67`, `:151` say only cancellation ends a wait)
and add an r2 note under design r1 `:107`: in account mode the wait also ends, with `applied: true`, when the hub can no
longer be read as this account or the backend/hub changed or the target vanished. Tests: one per code asserting `applied`.
Do NOT change `MESSAGES` texts for this: several say "변경하지 않았어요", so for an `applied` error the panel ignores
`error.message` (except TARGET_GONE, already post-edit worded) and renders its own applied wording.

C5 (O3) — keep the repair-time `scanHubCandidates` (core enforces "complete scan", contract `:140`); pass `onProgress`
through recover/reset to it. Test: progress reaches the caller with the scan's totals.

C6 (O4) — `parseAccountSave` must not copy a `Uint8Array` input into a Blob (`core.js:196`); stream it as-is (e.g. a
ReadableStream enqueuing the array). Existing parser tests must stay green; add an assertion that no Blob is built for it.

C7 (suite gaps; tests + mutants, each mutant killed by an AssertionError):
- A1: a matching DB read that STARTS before the settle window and FINISHES after it must not confirm; another read started
  after the window must. TRAP: the fixture only advances `now` inside `sleep` — add a hook that advances time while the
  fake DB body is being read. Mutant: drop `readStarted - quietSince >= ACCOUNT_SAVE_SETTLE_MS` (`core.js:~616`).
- A2: receipt with the target deleted from the hub but a healthy LOCAL copy → `TARGET_GONE` (never `local-only`, never
  confirm). Mutant: ignore the `localFallback=false` argument.
- A3: backoff spacing 2 s → 4 s → … capped at 60 s, reset to 2 s on a new `__date`. Mutants: constant interval; no cap;
  no reset.
- Opus: mutants dropping each post-scan re-check in `editAccount` (`accountSettled`, `accountBroken`, `accountTarget`
  second calls, `core.js:~549-551`) must die (add tests if they survive).
- S3: account save with compression byte `2` on the root or pluginStorage block → `account-unavailable`, no edit.

## Done when
`npm test` all green, `npm run mutate` every mutant KILLED (report the new count), `npm run build` clean, `src/` free of
trailing `//` comments. Report: per change the code + test lines; the C4 enumeration; every caller-map row answered;
anything you could not verify here. Live verification is the orchestrator's (do not claim it).
