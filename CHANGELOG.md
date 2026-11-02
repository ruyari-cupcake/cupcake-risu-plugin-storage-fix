# Changelog

## 0.1.0 — 2026-11-03

- First version, published as **컵케익 리스 플러그인 저장소 고치기** (`cupcake-risu-plugin-storage-fix`) under the
  MIT License with the install page on GitHub Pages.
- Bookmarklet, short loader bookmarklet and console forms that run in a RisuAI web tab: diagnose the
  plugin storage index (`_coldpluginIndex` → OPFS `coldstorage_<id>.json`), offer the newest surviving
  index for recovery, or clear only the dangling pointer; refuse account / node / desktop storage.
- Re-checks the pointer, the broken state and the chosen index right before changing anything, and
  confirms the change on the saved `database/database.bin` before offering the reload.
- Verified on stock RisuAI v2026.10.292 (IndexedDB and OPFS databases), on risuai.xyz, and with
  CPM PROD 1.99.16 — evidence in `README.md`.
