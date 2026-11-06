# Implementation review synthesis — storage-fix 0.2.0 account mode

Astra: ran | Sol: ran | Opus: ran | agy: ran (model=Gemini 3.8 Flash (High))

Venue: detached worktree `_worktrees/rpf-review-020` (byte-identical to the checkout, `cmp` src/core.js + dist/console.js).
Exact-tree live gate during the round (`tests/live/work/gate-020.sh`, tree hash `92c38c03d3506432` before = after):
unit 201/201, 10 stock web scenarios + local loader + risuai.xyz loader + 5 account scenarios on risuai.xyz — all PASS.

Verdicts: Astra SHIP (3 suite gaps) · Opus SHIP (F1–F6, "fix F1–F3 in this unit") · Sol FIX BEFORE SHIP (2 Medium) ·
agy FIX BEFORE SHIP (3 findings, all rejected below).

## Accepted — fixed in this unit (source-checked)

| id | sev | finding | evidence I checked | fix |
|---|---|---|---|---|
| S1 | Med | account `no-index` returns before any hub read → after a reset whose save the hub rejected, re-running shows ✅ while the hub still names the dead pointer | `core.js:476-478`, `ui.js:423-425`; test `core.test.cjs:1386` pins zero requests | account no-index reads the hub DB: hub pointer string → `account-not-settled`; absent → `no-index` (identity + live re-check as in the pointer branch) |
| S2 | Med | `accountst=able` outranks `isNode`/`isTauri` → account edits on profiles the contract never changes; stock Tauri saves the DB to AppData files even in account mode (`globalApi.svelte.ts:455-470`) so a receipt there never resolves | `core.js:156-160`; contract `core-contract.md` "Node / Tauri profiles are never changed" | backend order Tauri → Node → account → web (Node/Tauri refused whatever `accountst` says) |
| O1 | Med | cache from a previous account: stock Logout (`unMigrationAccount`, `accountStorage.ts:194-221`) never clears `risuaiAccountCached`, a 200 read never writes it (`:102-166`) → after logging into B and loading, cache root = A; tool reads A's hub with A's token, identity check compares A with A, user stuck on "not settled" | as cited | drop the cache source when `fallbackRisuToken` exists with a different `id` |
| O2 | Low-Med | receipt ends after the edit on ACCOUNT_LOGIN / ACCOUNT_MISMATCH / CHANGED / UNCERTAIN; panel does not say the edit is already in the tab; docs say "ends only on abort" | `core.js:635-637`, contract `:151`, design `:107` | errors thrown after the live edit carry `applied: true`; panel says so; contract + design list the post-edit terminal cases (transient hub failures keep waiting) |
| O3 | Low | repair re-runs the full hub scan (core's own "complete scan" precondition, contract `:140`) with no progress; status promises "보통 몇 초" | `core.js:545` | keep the scan (core must not trust panel state); pass `onProgress` through recover/reset; panel shows n/N and drops the "몇 초" promise in account mode |
| O4 | Low | `parseAccountSave` copies the whole cached `database.bin` into a Blob to read one root block | `core.js:196` | stream the Uint8Array without a copy |
| O5 | Low | `missing: 'fetch'` (account only, `core.js:819`) shows the OPFS/http text | `ui.js:63-69, 419` | own `fetch` text |
| O6 | Low | live oracle: reset gate accepted `pointer:null` without a found block; device 2's pointer not asserted | `account-live.mjs:136`, `drive.mjs:623, 462` | `hasBlock`/`truncated` in `hubPointer`; reset gate requires `hasBlock`; device 2 must load exactly the hub's pointer (recover: `newest`; reset: the new index) |
| A1 | Med (suite) | no test for a DB read that STARTS before the settle window and finishes after it | `core.js:605-616` | test + mutant (drop `readStarted - quietSince` condition) |
| A2 | Med (suite) | receipt target-gone with a surviving LOCAL copy untested (the `localFallback=false` bypass) | `core.js:416-421, 621-627` | test + mutant |
| A3 | Low (suite) | backoff spacing / 60 s cap / reset-on-new-date unasserted | `core.js:640-641` | test + mutants |
| Op-m | Low (suite) | no mutant drops the post-scan re-checks | `core.js:549-551` | mutants |
| S3 | Low (suite) | account fixtures always gzip; unknown compression byte (2) untested | parser | test (expect unavailable, no edit) |
| S4 | Low (harness) | `hubSession` cold GETs without `no-store` | `account-live.mjs:29` | add `cache: 'no-store'` |
| S1-live | — | no live journey reopens an unconfirmed reset | — | new live scenario `account-reset-rejected` (stock DB write routed to 503 → panel waits, never ✅; reopen → not-settled, never ✅; hub still dead) |

## Rejected (source evidence)

- agy 1 "candidate sort inverted": the sort is `b.flushedAt - a.flushedAt` (newest first), `core.js:467`.
- agy 2 "indexes > 32 KB truncated": `PREFIX_READ_LIMIT` is 128 bytes and only gates the header check; once accepted the
  whole stream is read (`core.js:9, 704-713`).
- agy 3 "device gate stays hidden after a failed repair": after a repair error only rerun/reload are shown; recover/reset
  are hidden, and rerun re-diagnoses which restores the gate (`ui.js:359, 529-546`).
- Opus F6 "account-login doesn't test the token-source swap live": in a live session the cache root and the fallback hold
  the same token, so a live swap cannot be staged without a second login; the 403-on-every-read scenario does exercise
  both sources failing. Swap-success stays unit-covered (`core.test.cjs` token-order tests). Same reason for
  `expectAccountPanelClean` checking one token.
