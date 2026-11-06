# Design + test-plan review — storage-fix account mode (B: diagnose + repair)

Read-only. The OWNER already decided to build B (diagnose + repair for Risu account storage) — do not argue whether to do
it; critique HOW. No code exists yet for the account branch.

## Evidence pack (absolute paths)
- Design: `/home/cupcake/workspace/cupcake/cupcake-risu-plugin-storage-fix/.report/account-mode-design.md`
- Current tool (0.1.1, web-only): `/home/cupcake/workspace/cupcake/cupcake-risu-plugin-storage-fix/src/core.js`, `src/ui.js`;
  contract `.report/core-contract.md`; settle rule `.report/fix-r2-settle.md`; wait rule `.report/fix-r3-progress-deadline.md`;
  unit tests `tests/core.test.cjs`; live harness `tests/live/drive.mjs` + `tests/live/README.md`.
- Stock RisuAI GitHub release v2026.10.294 files (fetched raw, file name = path with `/`→`_`):
  `/tmp/claude-1000/-home-cupcake-workspace-cupcake/73043374-ee52-4fa0-b757-a28094c44049/scratchpad/v294/`
  (`src_ts_storage_accountStorage.ts`, `src_ts_storage_autoStorage.ts`, `src_ts_sionyw.ts`, `src_ts_process_coldstorage.svelte.ts`,
  `src_ts_process_pluginStorageStore.ts`, `src_ts_globalApi.svelte.ts`, `src_ts_storage_risuSave.ts`, `src_ts_characterCards.ts`,
  `src_lib_Setting_Pages_UserSettings.svelte`, `src_ts_plugins_plugins.svelte.ts`).
- Measurements: probe `tests/live/account-save-probe.cjs` → result `tests/live/work/result-account-save-probe.json`; token/CORS
  probe `/home/cupcake/workspace/cupcake/_temp_repo-IPC-v2/.report/storage-fix-account-mode-2026-11-06/live-account-token.json`
  (+ `.cjs`); hub curl probe `/tmp/claude-1000/-home-cupcake-workspace-cupcake/73043374-ee52-4fa0-b757-a28094c44049/scratchpad/risu_hub_probe2.py`
  (results summarised in the design as M1–M4).

## Judgment points (every seat)
1. **Wrong-repair risk** (worst outcome: the tool repoints or clears a pointer while stock could still load the index, or
   repoints to an index that other devices cannot read). Walk every hub/local status combination in the design's read rule
   and say which ones could classify a loadable index as broken.
2. **The receipt's foundation**: 303 `{match:true}` for the cached `__date` ⇒ hub bytes = cached bytes (design § Open
   question). Any stock code path that writes the cache/date in a way that breaks this? Any path where the cache is stale but
   the date matches?
3. **Multi-device / multi-tab**: another device or tab saving its stale DB (dead pointer) after the repair; another device's
   plugin flush; `reloadSession`. Can the receipt confirm falsely? Is the panel's warning enough, or is a check needed?
4. **Candidates**: hub-only rule, `flushedAt` ranking from index-trash `at`, `missingLarge` vs the hub key set, the scan cost
   and prefix-cancel; the trash grace (stock deletes old indexes 1 h after a load) racing the user's pick.
5. **Test plan**: name the plausible broken implementations the planned unit tests would NOT catch, and gaps in the live plan
   (official risuai.xyz, TEST account only, Playwright).

Output: verdict (DESIGN OK / CHANGE BEFORE BUILD), numbered findings each with the stock file:line or design section, a
concrete failure scenario and the change you propose; "could not verify here" list. Under ~900 words.
