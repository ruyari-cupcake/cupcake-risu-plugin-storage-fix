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
   - `recover` — the database points at a missing index while the newest index is still on disk:
     the newest is offered first, recovered, and its values read back after the reload.
   - `LOCAL_CONSOLE=1 … reset loader` serves the hosted `console.js` URL from this checkout;
     `BASE_URL=https://risuai.xyz/` runs on the official site instead of `STOCK_DIR` (its CSP has
     to allow the loader's script; it also asks "leave site?" on reload, which the driver accepts).
3. `bash tests/live/run-all.sh` runs build, unit, mutation and every scenario above.
4. After a release push, run the loader once without `LOCAL_CONSOLE` (it then loads the live
   GitHub Pages bundle): `BASE_URL=https://risuai.xyz/ node tests/live/drive.mjs reset loader`.
