# Caller map — `src/core.js` (account-mode unit)

Caller: `src/ui.js` `openFixPanel` → `RisuPluginStorageFix.createBrowserEnv(window)` | Expects: an env with every member the core uses, incl. the new `fetch`, `accountCache`, `randomId`, `hubBase` | Guarded by: tests/ui.test.cjs (load + waiting display), live drive.mjs (orchestrator-owned)
Caller: `src/ui.js` `runDiagnose` → `diagnose(env, {signal, onProgress})` | Expects: the pinned state list in `05-sol-spec.md` § API (names + fields exactly), `onProgress(done, total)` | Guarded by: new account unit tests + existing web tests
Caller: `src/ui.js` `runRepair` → `recover(env, {pointer, candidateId, signal, onWaiting, devicesClosed})` / `reset(env, {pointer, signal, onWaiting, devicesClosed})` | Expects: resolves `{confirmed: true, persistedPointer}`; rejects with `FixError` whose `code` is in the pinned list; `onWaiting({waitedMs, sinceSaveMs, saves, hubRejecting})` | Guarded by: unit tests per code + live account scenarios
Caller: `src/ui.js` `rpfErrorText` → `FixError.message` | Expects: Korean user text, never a token/root field | Guarded by: new "token never in output" test
Caller: `tests/core.test.cjs` (existing web suites) | Expects: every 0.1.1 web behaviour unchanged (states, receipt, settle, refusals) | Guarded by: themselves — must stay green without edits except the account-refusal case at :226
Caller: `tests/mutate.cjs` | Expects: every mutant applies exactly once to `src/core.js` and is killed | Guarded by: `npm run mutate`
Caller: `tests/bundle.test.cjs` + `scripts/build` (`npm run build`) | Expects: `src/` has no trailing `//` comments; the bundle parses with newlines removed; `@strip-in-bundle` line kept | Guarded by: `npm test` (bundle test)
Caller: `tests/live/drive.mjs` via `dist/console.js` | Expects: web scenarios unchanged; account scenarios added by the orchestrator against the pinned API | Guarded by: `tests/live/run-all.sh` (orchestrator runs it)
