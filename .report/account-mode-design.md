# Account mode: diagnose + repair (design r1, v0.2.0)

Owner 2026-11-06: "계정모드는 못고쳐? 보통 계정 로그인 하고 쓰는 사람들은 대부분 동기화 해둘텐데" → "확인해봐" →
"실제 브라우저에서 가능하면 당연히 B로 해야지" (B = diagnose + repair). This lifts the 0.1.x rule "account storage stays
refused". Node and Tauri stay refused. r1 = after the design round (`account-mode-review/`: Astra, Sol, Opus, agy — all
CHANGE BEFORE BUILD; every adopted change is marked [Rn]).

## Existing behaviour and why
0.1.1 refuses account mode before touching anything: stock's account read falls back to local on ANY hub non-200, so a
transient hub failure and a really missing index both surface as the same `Failed to load plugin storage index`, and a wrong
repair in account mode syncs to every device. The hub itself, asked directly, separates the cases — so the tool asks it.

## Stock facts (GitHub release v2026.10.294; file:line in `src/`)
- S1 login: hub login iframe → `db.account = {id, token, data}` (`lib/Setting/Pages/UserSettings.svelte:23-41`); Sionyw/DPoP is
  `import.meta.env.DEV` only (`:147-154`). Turning sync on writes `localStorage.fallbackRisuToken = JSON.stringify(db.account)`
  (`ts/storage/autoStorage.ts:74`, `:160`); a 403 in an account read/write re-prompts and rewrites it (`accountStorage.ts`).
  With `db.account` set, Settings → Account shows **Logout** = `unMigrationAccount()` (copies to local, drops `accountst` and the
  token, reloads; `UserSettings.svelte:139-145`, `accountStorage.ts:194-220`).
- S2 every account call = `ts/sionyw.ts fetchProtectedResource :46-63`: unless `localStorage.ignoreRisuAuth === 'true'`, token =
  `DBState.db.account.token`, else `fallbackRisuToken.token`, header `x-risu-auth`, plain page `fetch`.
- S3 hub = `ts/characterCards.ts:24-31` (module-load constant): `localStorage.hub === 'nightly'` → `https://nightly.sv.risuai.xyz`
  (or a nightly build flag the page does not expose), else `https://sv.risuai.xyz`.
- S4 cold read (`ts/process/coldstorage.svelte.ts:43-69`): account → `GET <hub>/hub/account/coldstorage`, `x-risu-key: <id>`;
  200 → fflate-gzip JSON (decode failure → null, NO local fallback); any non-200 → local fallback, on web OPFS
  `coldstorage_<id>.json` (`:95-112`). List: `x-risu-key: @list-keys` → `{items: string[]}` (`:207-220`). Remove = POST
  `x-risu-key: remove`, `x-action: remove`, body `{keys}` (`:271-290`).
- S5 plugin store (`ts/process/pluginStorageStore.ts`): accept rule as 0.1.x (`doLoad :169-222`). Every flush writes a NEW index
  id and puts `{id: oldPointer, at: now, index: true}` in the new index's trash (`doFlush :449-500`); `indexTrashGrace` 1 h,
  `trashGrace` 24 h (`:52-60`); due trash is deleted right after a load (`collectTrash :320-340`) — in account mode a hub remove,
  even before (and regardless of) the next DB save.
- S6 save loop (`ts/globalApi.svelte.ts:405-482`): saves only when dirty (`:411-416`); account → encoder `compression: true`;
  `AccountStorage.setItem` (`accountStorage.ts:23-95`) lazily fetches a session number, POSTs `/api/account/write` with
  `x-risu-save-date: Date.now()`, then writes the IndexedDB cache `risuaiAccountCached` bytes and, in a separate un-awaited
  write, `__date` — after the response and BEFORE its status is checked (also for `reloadSession`, warn-403, 5xx). Warn-403
  returns without throwing (`:86-89`). No `dbbackup-*`; `sleep(3000)` after each account save. Same `risu-db` tab guard.
- S7 DB read (`AccountStorage.getItem :97-115`): `GET <hub>/api/account/read/<hex(key)>|<uuid>` (fresh uuid per database read)
  with `x-risu-key` and `x-risu-save-date`; 303 `{match:true}` → stock uses its cache.
- S8 block order (`ts/storage/risuSave.ts:148-205`, `encode() :322-334`): root, preset, modules, loadouts, plugins,
  **pluginStorage**, then characters (with chats), KV, config; later saves reassign the same keys, so the order holds. The root
  block contains `db.account` (incl. the token) on the first encode (`:140-152`).

## Measured (TEST account `miseltest2221`, official risuai.xyz; drivers in `tests/live/`)
- M1 page realm after turning sync on: fallback token present; page `fetch` list 200 / missing 404 / bad or no token 403; `ACAO: *`.
- M2 list items are plain key strings; cold GET has no date/size header; HEAD → 400; stock-shaped remove → 200.
- M3 a live `pluginCustomStorage` edit: cache `__date` changed after ~3 s; `GET read` with that date → 303 `{match:true}`, a wrong
  date → 200 full DB holding the edit. (r1 no longer relies on 303 — see [R1].)
- M4 an account DB without `pluginCustomStorage` saves an empty (gzip of "") pluginStorage block.

## Design
Backend selection unchanged (`accountst === 'able'` → account; node, Tauri refused). New env members (real ones in
`createBrowserEnv`, fakes in tests): `fetch`, `accountCache` (read-only IndexedDB `risuaiAccountCached`, opened ONLY in account
mode, same never-create open as `risuai`), `randomId()`, and the hub base from S3 read at run time.

**Hub requests** — every request is a GET to the S3 hub with `x-risu-auth`, `cache: 'no-store'` and the run's AbortSignal; a DB
read always gets a fresh `|<uuid>` suffix [agy 3, Opus]. The tool never sends POST/remove. `HUB_SCAN_CONCURRENCY` (4) caps
requests in flight. A 429 or 5xx during a scan stops the scan without retry [Opus 9].

**Authoritative DB read [R1: Astra 1, Sol 1, Opus 2]** — `GET read` with `x-risu-save-date: 0` (always 200 + body), streamed:
parse block headers incrementally, keep the root and pluginStorage blocks, cancel the body right after pluginStorage (S8). The
download is the settings/preset/module/plugin-script part, compressed (a few MB on a heavy profile), never the chats. Result:
`{accountId (root.account.id or null), pointer, hasBlock}`. Root fields are never logged or shown [Opus 8]. The cache and its
`__date` are only a **trigger** (a stock save happened), never evidence of what the hub holds.

**Token and identity [R3: Sol 7, Opus 7]** — stock's first choice is the in-memory `db.account.token`; the closest readable copy
is the root block of the account cache (S6/S8). Token sources in stock order: cache-root `account` first, then
`fallbackRisuToken`. The first source is tried; on a 403 the other is tried; `account-login` only when every available source
is rejected (after a stock re-login the fallback is new while the cache root keeps the old token until the next save). The
accepted source is kept for the whole run. `ignoreRisuAuth === 'true'` → `account-auth-unknown` ("Risu signs in differently
here; the tool cannot check — nothing changed"). No token at all → `account-login`. Identity binding: the authoritative DB's
`root.account.id`, when present, must equal the accepted source's `id`; else `account-mismatch` (refuse).

**Reading an index the way stock does [R2: Opus 3, agy 1]** — `GET coldstorage <id>`:
- 200 → gunzip + parse: DecompressionStream failure → `uncertain`; JSON/shape failure → `unreadable` (stock has no fallback).
- 404 → missing on the hub only if the id is also absent from `@list-keys` and a second GET after `HUB_MISSING_RECHECK_MS`
  (2 s) is still 404 (else `unavailable`). Then the local OPFS read: `missing` → broken `missing`; `unreadable` → broken
  `unreadable`; `uncertain` → `uncertain`; `healthy` → **`local-only`** (this device reads a leftover local copy; the account
  server and every other device do not — no repair, honest text).
- 403 → `login`; anything else / network error → `unavailable` (status kept).

**diagnose (account)** → `no-index` | `healthy` (hub reads it; text: the error was a passing server problem, reload) |
`local-only` | `account-login` | `account-auth-unknown` | `account-mismatch` | `account-unavailable {status, phase}` |
`uncertain` | `broken {reason, candidates, uncertainCount}`. Order: token → authoritative DB read (identity; its pointer must equal
the live pointer, else `NOT_SETTLED`-like `account-not-settled`) → pointer read → scan.

**Candidates (account) [R4: Sol 5, agy 4]** — hub only (a local-only index would 404 on every other device). `@list-keys`
(non-200 → `account-unavailable`); every listed key except the pointer: `GET`, stream-gunzip, cancel the body when the 0.1.x
prefix rule rejects it; indexes are fully parsed. Any listed key that does not answer 200 (a 404 included: a single 404 is
not trusted, and stock's trash collection may be deleting it right now) stops the scan → `account-unavailable {phase: 'scan'}`:
an incomplete scan never offers recover or reset; a re-run after stock's deletion finishes lists the key no more. Fields: `id`, `flushedAt` = max
`at` of its `index: true` trash entries (client clock; `null` for a first index), `keyCount`, `sampleKeys`, `largeCount`,
`missingLarge` (`l` ids absent from the hub key set). Order: `flushedAt` desc (null last), then `keyCount` desc, then `id`.
Cost: one request per cold key, measured hub worker time 0.25–0.9 s → ≈ N × 0.5 s / 4 in flight (200 cold chats ≈ 25 s).

**recover / reset (account)** — preconditions, all re-checked right before the one edit: backend still account, same token
source, authoritative DB pointer === live pointer === diagnosed pointer (`CHANGED` / `NOT_SETTLED`), pointer still broken by
the [R2] rule (`NOT_BROKEN`, or typed `ACCOUNT_*` errors without editing), candidate re-read on the hub valid
(`CANDIDATE_INVALID`). Then exactly one live-object edit (as 0.1.x).

**Receipt (`waitForPersisted`, account) [R1, R5: Astra 2-3, Sol 2-4, agy 2, Opus 5]** — every `SAVE_POLL_INTERVAL_MS` read the
cache `__date` only (cheap, local). An authoritative DB read is triggered by (a) a new `__date`, (b) the settle window closing
with no read since it closed, or (c) a backoff timer while unresolved (`HUB_RECHECK_BACKOFF_MS` 2 s doubling to
`HUB_RECHECK_MAX_MS` 60 s; reset on a new `__date`) — so a failed hub read retries without a new save, and acceptance never
waits for the backoff once the window has closed. Accept only when, in one round: the live pointer has been unchanged for `ACCOUNT_SAVE_SETTLE_MS` (stock flush
1000 + account post-save sleep 3000 + idle 500 + poll 500 = 5000), THEN a fresh authoritative read shows hub pointer === live
pointer, the identity still matches, and the predicate holds — target or a successor index, each re-read **fresh** on the hub and
valid at that moment (a target deleted by another device's trash collection is reported, never confirmed). Never gives up on its
own (R32); ends only on abort. `onWaiting` additionally reports `hubRejecting` after `HUB_REJECT_HINT_SAVES` (3) consecutive new
`__date`s whose fresh hub read still shows the pre-edit pointer (warn-403 / another device holds the session).

**r2 terminal receipt clarification (review C4)** — there is still no deadline: transient hub failures keep waiting.
The wait also ends if the hub can no longer be read as this account (login, identity mismatch, changed auth method), the
backend/hub changes, the target vanishes, or a live API/capability/adapter fails. After the one live edit these errors carry
`applied: true` (after public error mapping); pre-edit errors do not. Explicit `CANCELLED` remains unchanged. The panel
must use applied wording instead of the pre-edit message; the tool never rolls back or repeats the edit.

**Multi-device gate [R6: Opus 4, Sol 2]** — before recover or reset in account mode the user ticks "다른 기기와 다른 탭의 리스를
모두 닫았어요" (a gate, not a warning). The success text tells them to open Risu fresh on other devices (an idle device opened
before the repair will save its stale DB on its first edit and undo it — then run the tool again). No read-only check can prevent
a later foreign save; the README says so.

**Preservation contract (changed)** — still exactly one stored value: `_coldpluginIndex` on the live object. Network: only in
account mode, only GETs to the stock hub (S3) that stock itself makes, with the login stock keeps on this device; never a write
or remove; the token only ever goes into `x-risu-auth` to the hub; web mode never opens `risuaiAccountCached` and makes no request.

**Panel** — `healthy` (account): "서버에서 지금은 목차를 읽을 수 있어요 — 잠깐 서버가 응답하지 않았던 것 같아요. 새로고침해
보세요" + reload. `local-only`: this device reads an old local copy; other devices fail; the tool changes nothing (a plugin
saving once on this device uploads a new index, though big values may stay missing elsewhere). `account-login`: "리스를
새로고침하고, 리스가 로그인 창을 띄우면 거기서 로그인한 뒤 다시 실행해 주세요" — never Settings/Logout [R7: Astra 4, Opus 1]; if no
login box appears and Risu works, the tool cannot use this device's login — nothing changed. `account-unavailable`: server or
scan trouble, try later, nothing changed. `account-mismatch` / `account-auth-unknown`: nothing changed. Broken: "계정 서버에
목차가 없어요"; candidates with `flushedAt` (or "시점 정보 없음"), newest preselected; candidate list + reset confirmation say the
change reaches every device; the existing "picking one makes older ones unrecoverable" note stays (S5 collectTrash). The device
gate checkbox enables the recover/reset buttons. Waiting stall hint says "다른 탭이나 기기"; `hubRejecting` adds "서버가 저장을
받지 않고 있어요". Bottom note in account mode: "계정 모드에서는 리스가 쓰는 계정 서버에 읽기 요청만 보내요".

## Tests [R8]
Unit (`tests/core.test.cjs`; fake hub with per-key status/body/latency and a GET-only guard that fails on any other method; fake
account cache whose saver writes bytes, yields, then the date, with variants where the hub rejects the write; fake clock): every
account state incl. `local-only`, 404-but-listed, single-404 recheck, 200-undecodable → uncertain, identity mismatch,
`ignoreRisuAuth`; scan: prefix cancel (reader cancelled), concurrency ≤ 4, a 503 on the newest index stops the scan (no
recover/reset), a listed key that 404s also stops it (R4), ordering incl. ties; abort cancels in-flight fetches; receipt: torn cache (bytes new,
date old) never confirms, a rejected write (cache new, hub old) never confirms, 503 then 200 with no new `__date` confirms after
backoff, a foreign save of the dead pointer during settle does not confirm, a target deleted before the final read does not
confirm, `hubRejecting` after 3 saves; every DB read URL distinct and `no-store`; web mode never opens the account cache or calls
fetch; the token never appears in any returned object/error message. Mutants: one per new guard; the old "allow account backend"
mutant is replaced. Live (`tests/live/drive.mjs`, official risuai.xyz, TEST account): `account-recover` (probe plugin writes twice
→ X then Y; harness removes Y with the stock remove request → reload → stock error → tool lists X first → gate → recover → reload
reads the values; a fresh second profile logs in, loads from the account, reads them), `account-reset`, `account-unavailable`
(cold GET routed to 503 → nothing changed), `account-login` (fallback + cache token replaced → 403 → nothing changed),
`account-local-only` (hub index removed but OPFS copy kept → local-only, nothing changed). Existing web scenarios unchanged; the
old `account` (refusal) scenario is replaced by these.

## Residuals (stated, not hidden)
Server-side semantics are not readable (r1 does not depend on 303); a device left open before the repair can undo it later;
`flushedAt` uses device clocks; hub rate limits are unknown (scan stops on 429/5xx).
