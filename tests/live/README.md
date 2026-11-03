# Live checks: built `dist/` tool on a real RisuAI web build

`drive.mjs` boots RisuAI in headless Chromium with a fresh profile, adds a tiny v3 plugin ("probe")
so the host's real `risuai.pluginStorage` can be called from its sandbox, breaks the profile the
way users hit it, runs the built tool, presses its buttons, reloads, and checks the storage again.
Profiles, results and failure screenshots land in `work/` (git-ignored; profiles are deleted).

Needs Playwright with Chromium: `PLAYWRIGHT_MODULE=/path/to/node_modules/playwright`, or
`npm i -D playwright && npx playwright install chromium` in the repo.

1. Stock RisuAI from GitHub (the authority), built as a static web app:
   ```bash
   git clone --depth 1 https://github.com/kwaroran/RisuAI.git ~/vanilla-risu && cd ~/vanilla-risu
   pnpm install --frozen-lockfile
   VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm exec vite build --outDir dist
   export STOCK_DIR=~/vanilla-risu/dist
   ```
2. Scenarios (`node tests/live/drive.mjs <scenario> [bookmarklet|console|loader]`):
   - `venue` — harness sanity only: deleting the OPFS `coldstorage_*` files reproduces
     `Failed to load plugin storage index` on every plugin storage call.
   - `healthy` — the tool says "정상" and changes nothing.
   - `account` — with `accountst=able` the tool refuses and changes nothing.
   - `reset` — dead index, no survivor: reset → the panel's reload button → the dead pointer never
     returns, a legacy inline value survives, a new write persists across another reload.
   - `opfs-db` — the same with the host database in OPFS (`opfs_flag!`), asserting the location.
   - `reset-race` — a plugin writes while the tool is confirming; the driver presses the panel's
     reload IMMEDIATELY after ✅ (on purpose) and the raced value must still be there.
   - `recover` — the database points at a missing index while the newest index is still on disk:
     the newest is offered first, recovered, and its values read back after the reload.
   - `recover-account-hint` — with `localStorage.dosync = 'avoid'` (account logout / declined sync):
     the warning shows, nothing is preselected, an empty pick changes nothing, a deliberate pick recovers.
   - `not-settled` — another tab announces itself on stock's `risu-db` channel, so this tab stops
     saving and memory diverges from the saved file: the tool refuses (`NOT_SETTLED`), changes
     nothing and offers the reload; after it the normal reset confirms.
   - `receipt-stuck` — the same channel message right before the reset is confirmed, so the host
     never saves the edit: the panel shows its ⏳ still-waiting line, after a minute without a new
     save it names stock's "현재 탭이 비활성화되었습니다" alert but keeps waiting (no ⚠ on its own, no
     panel reload button), the saved file still holds the dead pointer, and stock's alert OK (a reload)
     + re-run repairs normally with the other values kept.
   - `aged-restore` / `aged-reset` — the host page's clock is moved ahead (init script, stock code
     untouched) past stock's trash grace (old indexes 1 h, large values 24 h): stock itself deletes
     the old index, an older database comes back (real dead state) → recover; or the cold files
     are evicted days later → reset. Values must survive later +2 h and +27 h reloads, and running
     the tool again says healthy.
   - Every save wait checks that the saved `pluginStorage` block equals the live object (parsed per
     stock `risuSave.ts`, no tool code); a profile holding both database files is refused.
   - `LOCAL_CONSOLE=1 … reset loader` serves the hosted `console.js` URL from this checkout;
     `BASE_URL=https://risuai.xyz/` runs on the official site instead of `STOCK_DIR` (its CSP has
     to allow the loader's script; it also asks "leave site?" on reload, which the driver accepts).
   - Heavy-database measurement (not in `run-all.sh`): `RPF_BULK_MB=500` on `reset` / `opfs-db` / `reset-race`
     adds that many MB of chat text (stock-shaped characters) before the break and records `confirmMs`
     (reset click → ✅/⚠); `RPF_CPU_THROTTLE=6` slows the host page's CPU (DevTools emulation, storage I/O
     untouched). Since 0.1.1 the tool never gives up on its own, so a heavy run must end ✅; heavy runs also
     record a 1 s `timeline` of the newest backup number and the pointer. Run memory-capped, e.g.
     `systemd-run --user --scope -p MemoryMax=12G -p MemorySwapMax=0 node tests/live/drive.mjs reset-race bookmarklet`.
3. `bash tests/live/run-all.sh` runs build, unit, mutation and every scenario above. It freezes the tree
   after the build (`venue-guard.sh`): an edit to `src/`, `dist/`, `tests/` or `scripts/` during the run
   stops the gate with `VENUE_CHANGED_MID_RUN`, so one "every step passed" never mixes two versions.
   Edit nothing in this checkout while it runs.
4. After a release push, run the loader once without `LOCAL_CONSOLE` (it then loads the live
   GitHub Pages bundle): `BASE_URL=https://risuai.xyz/ node tests/live/drive.mjs reset loader`.
