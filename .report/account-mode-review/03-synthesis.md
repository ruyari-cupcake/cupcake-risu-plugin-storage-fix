# Design round synthesis — account mode (2026-11-06)

Astra: ran | Sol: ran | Opus: ran | agy: ran (model=Gemini 3.8 Flash (High))

All four: CHANGE BEFORE BUILD. Outputs: Astra/Sol/Opus in the session transcript (summarised here), agy `02-agy.txt`.
Design r1 (`../account-mode-design.md`) marks each adopted change [Rn].

## Adopted
- R1 receipt/settle oracle = fresh authoritative hub DB read (save-date 0, `|uuid`, no-store, streamed to the pluginStorage
  block); cache + `__date` only a trigger — Astra 1, Sol 1, Opus 2 (stock writes cache bytes and date separately, before the
  status check; a torn or rejected save could make 303 vouch for bytes the hub never stored).
- R2 read rule: hub-missing needs list-absence + second 404; 404 + local healthy = `local-only` (not "healthy"); 404 + local
  unreadable = broken — Opus 3, agy 1. Listed-key 404 during the scan = scan incomplete (advisor: same distrust of a single 404).
- R3 token + identity: stock order (cache root, then fallback), try the other on 403, `account-login` only when all are rejected;
  hub DB `root.account.id` must match — Sol 7, Opus 7, advisor.
- R4 scan completeness: any non-200 on a listed key stops the scan, no repair offered; stop on 429/5xx; abort reaches fetch and
  readers; concurrency 4; deterministic tie order — Sol 5-6, Opus 9, agy 4.1.
- R5 receipt liveness: backoff re-read without a new `__date`, settle-close trigger, fresh read after the 5 s account settle,
  target/successor re-validated fresh at acceptance (`TARGET_GONE`), `hubRejecting` hint — Astra 2-3, Sol 2-4, agy 2, Opus 5.
- R6 multi-device gate enforced in core (`devicesClosed: true`) and in the panel — Opus 4, Sol 2.
- R7 login advice = reload only, never Settings/Logout; a unit test forbids those words in account texts — Astra 4, Opus 1.
- R8 tests: GET-only fake hub, torn-cache saver, rejected-write, 503-then-200, foreign save during settle, target deleted, token
  never in any output, web mode never opens the account cache — all seats' suite-gap lists; Opus 10 copy sweep (README, rules,
  contract, mutate.cjs account mutant, core.test.cjs:226, drive.mjs account scenario, run-all.sh, install page).

## Not adopted (reason)
- Opus 4 "keep watching after confirmation and report a foreign undo": a stale device can save hours later; no bounded watch
  catches that, and an unbounded one keeps downloading. Replaced by the R6 gate + success text + README residual.
- Opus 9 "skip keys the DB references for chats": needs the character blocks the authoritative read deliberately does not
  download; prefix-cancel + concurrency + stop-on-429/5xx bound the cost instead.
- agy 4.2 extra confirmation when `missingLarge > 0`: the existing inline warning (same as web 0.1.x) stays.
- Opus 6 trash-intersection flag per candidate: the existing note "picking one makes older ones unrecoverable" covers it.
- Probing 303 semantics further (Opus 2 live probe): r1 no longer depends on 303.
No second design round: the implementation round reviews the code that does not exist yet.
