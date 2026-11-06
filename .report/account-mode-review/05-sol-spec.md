# Implementation spec — storage-fix account mode, core layer (for the Sol implementer)

Repo: `/home/cupcake/workspace/cupcake/cupcake-risu-plugin-storage-fix` (public MIT; a `main` push is a release — do NOT commit or
push anything). Design (authority): `.report/account-mode-design.md` (r1). Design-round synthesis: `.report/account-mode-review/03-synthesis.md`.
Existing contract: `.report/core-contract.md`; settle rule `.report/fix-r2-settle.md`; wait rule `.report/fix-r3-progress-deadline.md`.
Stock source (GitHub release v2026.10.294, raw): `/tmp/claude-1000/-home-cupcake-workspace-cupcake/73043374-ee52-4fa0-b757-a28094c44049/scratchpad/v294/`.

## Hard rules (read first)
- `src/` carries NO trailing `//` comments anywhere (the bookmarklet is the bundle with every newline removed; `tests/bundle.test.cjs`
  gates it). Use `/* */` or a comment on its own line only where the existing file already does (check how `src/core.js` comments).
- Owned files: `src/core.js`, `tests/core.test.cjs`, `tests/mutate.cjs`, `.report/core-contract.md` (API, outcome and
  preservation sections for account mode). Do NOT touch: `src/ui.js`, `tests/ui.test.cjs`, `tests/live/**`, `README.md`,
  `index.html`, `src/install.template.html`, `dist/`, `package.json`, any rules file. The orchestrator writes the panel and live
  harness in parallel against the API below — keep names exact.
- Venue: `npm test`, `npm run mutate`, `npm run build` in the repo. There is NO live venue, no credentials and no network for you:
  never call a Risu server. Anything beyond the unit/bundle/mutation level goes into a "could not verify here" list, never "fixed".
- Web mode (accountst !== 'able') must behave exactly as 0.1.1: no `fetch`, never open `risuaiAccountCached`. Existing web tests stay
  green unedited, except `tests/core.test.cjs` ~:226 (account → `unsupported-backend`), which becomes account-mode tests, and the
  `tests/mutate.cjs` ~:12 "allow account backend" mutant, which is replaced by account-guard mutants.

## API (pinned — the panel codes against this)
`backend(env)` unchanged; `unsupported-backend` remains only for `node` / `tauri`.

`diagnose(env, {signal, onProgress})` in account mode returns one of (all carry `backend: 'account'`):
- `{state:'no-index'}` — live pointer not a string.
- `{state:'healthy', pointer, keyCount}` — the hub returns the pointer's index (200, valid).
- `{state:'local-only', pointer, keyCount}` — hub-missing per the R2 rule, local OPFS copy valid.
- `{state:'account-login'}` — no token, or every token source rejected (403).
- `{state:'account-auth-unknown'}` — `localStorage.ignoreRisuAuth === 'true'`.
- `{state:'account-mismatch'}` — hub DB `root.account.id` ≠ accepted token source `id`.
- `{state:'account-unavailable', status, phase}` — `status`: number or `null` (network/abort-free failure); `phase`: `'db'` |
  `'index'` | `'list'` | `'scan'`.
- `{state:'account-not-settled', pointer}` — authoritative hub DB pointer ≠ live pointer.
- `{state:'uncertain', pointer}` — hub 200 but DecompressionStream fails, or local read uncertain.
- `{state:'broken', pointer, reason: 'missing'|'unreadable', candidates, uncertainCount}` — candidates
  `[{id, flushedAt: number|null, keyCount, sampleKeys, largeCount, missingLarge}]` ordered `flushedAt` desc (null last), then
  `keyCount` desc, then `id` asc. `uncertainCount` = listed index-prefixed keys whose gunzip failed (they are not offered).
- The existing `not-risu`, `not-ready`, `unsupported-browser` (OPFS + DecompressionStream + `env.fetch` required in account mode)
  keep their meaning.

`recover(env, {pointer, candidateId, signal, onWaiting, devicesClosed})`, `reset(env, {pointer, signal, onWaiting, devicesClosed})`:
account mode requires `devicesClosed === true` (else `FixError('DEVICES_NOT_CONFIRMED')`, checked first, before any read). Web mode
ignores it. Resolve `{confirmed: true, persistedPointer}`. New `FixError` codes with Korean messages (add to `MESSAGES`; never
include a token or root field): `DEVICES_NOT_CONFIRMED`, `ACCOUNT_LOGIN`, `ACCOUNT_UNAVAILABLE`, `ACCOUNT_MISMATCH`, `TARGET_GONE`
(persisted hub pointer = target but the target index is no longer readable on the hub by the R2 rule; the edit stays, nothing is
replayed). Existing codes keep their meaning in account mode: `NOT_SETTLED` (authoritative hub DB pointer ≠ diagnosed pointer before
the edit), `CHANGED`, `NOT_BROKEN`, `CANDIDATE_INVALID`, `UNCERTAIN`, `CANCELLED`.

`onWaiting({waitedMs, sinceSaveMs, saves, hubRejecting})` — `saves` counts new cache `__date`s in account mode; `hubRejecting`
true after `HUB_REJECT_HINT_SAVES` consecutive new `__date`s whose fresh hub read still shows the pre-edit pointer (false on web).

Env (real in `createBrowserEnv`, fake in tests): add `fetch(url, init)` (globalObj.fetch), `accountCache: {keys(), getItem(key)}`
(read-only IndexedDB `risuaiAccountCached`, store `keyvaluepairs`, never create — same abort-on-upgrade as `risuai`), `randomId()`
(crypto.randomUUID), `hubBase()` (reads `localStorage.hub` at call time: `'nightly'` → `https://nightly.sv.risuai.xyz`, else
`https://sv.risuai.xyz`).

## Named constants (add, with a one-line derivation comment in the existing style)
`HUB_SCAN_CONCURRENCY = 4`; `HUB_MISSING_RECHECK_MS = 2000`; `HUB_RECHECK_BACKOFF_MS = 2000`; `HUB_RECHECK_MAX_MS = 60000`;
`STOCK_ACCOUNT_POST_SAVE_MS = 3000` (globalApi.svelte.ts `sleep(3000)` after an account save);
`ACCOUNT_SAVE_SETTLE_MS = STOCK_PLUGIN_FLUSH_DELAY_MS + STOCK_ACCOUNT_POST_SAVE_MS + STOCK_SAVE_IDLE_MS + SAVE_POLL_INTERVAL_MS` (5000);
`HUB_REJECT_HINT_SAVES = 3`. No other fixed timeout: the receipt never gives up (R32); only abort ends it.

## Behaviour (design r1 is authoritative; summary)
- Every hub request: GET only, `x-risu-auth`, `cache: 'no-store'`, the run's AbortSignal; DB read URL
  `<hub>/api/account/read/<hex('database/database.bin')>|<env.randomId()>` with `x-risu-key: database/database.bin`,
  `x-risu-save-date: 0`. Cold: `<hub>/hub/account/coldstorage` with `x-risu-key: <id>` or `@list-keys`.
- Authoritative DB read: stream the body, parse RISUSAVE block headers incrementally (a header or length field may be split
  across chunks; truncation → treat as unavailable, not as a pointer), decode root (compression byte; account saves gzip) only for
  `account.id`, decode the pluginStorage block (empty gzip payload, M4 → `hasBlock: true, pointer: null`), cancel the reader right
  after the pluginStorage block. Never keep or return root fields other than `account.id`.
- Token sources (R3): cache root `account` {id, token} first (from `accountCache` `database/database.bin`, parsed locally — the
  same block parser over a Uint8Array), then `localStorage.fallbackRisuToken` JSON {id, token}. Try in order; on 403 try the next;
  keep the accepted source for the run.
- Index read rule R2, scan rule R4 (any non-200 on a listed key stops the scan → `account-unavailable` phase `scan`; 429/5xx stop
  without retry; prefix-cancel non-index items; concurrency cap; abort stops queued work and cancels in-flight bodies).
- recover/reset preconditions and the receipt per design § recover / reset and § Receipt, incl. the three read triggers (new
  `__date`, settle-window close, backoff), fresh target/successor validation at acceptance, `TARGET_GONE`, `hubRejecting`.
  Successor acceptance (a plugin flushed after the edit) mirrors 0.1.x `acceptsPersistedPointer`, but "valid" = fresh hub read.

## Tests you must add (fake hub + fake cache; design § Tests is the list, verbatim)
GET-only guard (any non-GET fails the test); torn-cache saver (bytes, yield, date) and rejected-write variant never confirm;
503-then-200 without a new `__date` confirms after backoff; foreign dead-pointer save during settle does not confirm; target
deleted before the final read → `TARGET_GONE`; `hubRejecting` after 3 saves; every account diagnose state incl. `local-only`,
404-but-listed, single-404 recheck, 200-undecodable → uncertain, identity mismatch, `ignoreRisuAuth`, token fallback on 403;
scan prefix cancel (reader cancelled), ≤ 4 in flight, newest-index 503 stops the scan, ordering incl. ties; abort cancels in-flight
fetches; DB read URLs distinct and `no-store`; `devicesClosed` required; web mode never touches `fetch` / `accountCache`; no token
string in any returned object or error message across all account tests. Mutants: one per new guard (each must be killed).

## Report back
Files changed; how each caller-map row (`04-caller-map.md`) behaves now and which test shows it; `npm test` / `npm run mutate` /
`npm run build` results (counts); every design rule you could not express in a unit test; "could not verify here" list.
