# Implementation review — storage-fix 0.2.0 account mode (diagnose + repair)

Read-only. Owner decided B (diagnose + repair for Risu account sync); design r1 + its review round are settled — review the
CODE against them. Venue (frozen copy of the tree under review): `/home/cupcake/workspace/cupcake/_worktrees/rpf-review-020`.

## Pack
- Design r1: `.report/account-mode-design.md`; design-round synthesis `.report/account-mode-review/03-synthesis.md`;
  implementation spec `05-sol-spec.md`; caller map `04-caller-map.md` (all paths relative to the venue).
- Full diff against 0.1.1: `/home/cupcake/workspace/cupcake/cupcake-risu-plugin-storage-fix/.report/account-mode-review/11-impl-diff.patch`.
- Stock RisuAI v2026.10.294 sources: `/tmp/claude-1000/-home-cupcake-workspace-cupcake/73043374-ee52-4fa0-b757-a28094c44049/scratchpad/v294/`.
- Evidence: `npm test` 201/201; `npm run mutate` 116/116 killed (AssertionError-only kills); live on official risuai.xyz with a
  TEST account — `tests/live/drive.mjs` account-recover (incl. a second profile that loads the account), account-reset (+ second
  profile), account-unavailable (503), account-login (403), account-local-only: all PASS on the build just before the last
  identity tightening (a present non-string hub `account.id` → `account-mismatch`); the full live gate on THIS exact tree
  (10 stock web scenarios + loader + the 5 account scenarios) is running in parallel — treat live evidence as pending.
- dist/ is generated from src/ by `npm run build` and left out of the patch.

## Judgment points (every seat)
1. Wrong-repair paths: can any hub/local/status combination reach `recover`/`reset` while stock could still load the index, or
   repoint to an index other devices cannot read? Walk `src/core.js` account read rule, scan, and the pre-edit re-checks.
2. False ✅: can the account receipt confirm without a FRESH authoritative hub read taken after the settle window, with hub
   pointer = live pointer and the target (or successor) re-validated on the hub at that moment? Check the three read triggers
   and the backoff.
3. Network/privacy: only GETs to the stock hub; token only in `x-risu-auth`; no token/root field in any returned object, error
   or panel text; web mode never calls fetch nor opens `risuaiAccountCached`; abort reaches in-flight fetches and readers.
4. Stream parser: split headers, truncated bodies, empty gzip pluginStorage block, compression byte handling, cancel after the
   pluginStorage block.
5. Panel (`src/ui.js`): device gate cannot be bypassed (core enforces `devicesClosed` too); no account text points at Settings /
   Logout; web texts unchanged in meaning.
6. Suite efficacy: name up to three plausible broken implementations the unit + mutation + live evidence would not catch.

Output: SHIP / FIX BEFORE SHIP; numbered findings with file:line, concrete failure scenario, severity; "could not verify here".
Under ~900 words.
