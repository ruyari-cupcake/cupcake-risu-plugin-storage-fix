# Changelog

## 0.1.1 — 2026-11-03

- The save check never gives up on its own (a big database on a slow device used to get a false warning after
  a fixed minute): the panel shows how long it has been waiting, and after a minute without a new RisuAI save
  it adds the two readings — a big save file is still being written (leave it), or RisuAI showed its own
  "현재 탭이 비활성화되었습니다" alert because another tab took the saving (press that alert's OK, then run the tool
  again). It keeps waiting and offers no reload of its own meanwhile, since reloading mid-save throws the save away.

## 0.1.0 — 2026-11-03

- First version, published as **컵케익 리스 플러그인 저장소 고치기** (`cupcake-risu-plugin-storage-fix`) under the
  MIT License with the install page on GitHub Pages.
- Bookmarklet, short loader bookmarklet and console forms that run in a RisuAI web tab: diagnose the
  plugin storage index (`_coldpluginIndex` → OPFS `coldstorage_<id>.json`), offer the newest surviving
  index for recovery, or clear only the dangling pointer; refuse account / node / desktop storage.
- Classifies the index file three ways: missing, unreadable (stock fails the same way) and uncertain
  (locked / I/O / stricter decompression) — uncertain never allows a change. Unsupported browsers
  (no OPFS, no DecompressionStream) and never-used plugin storage are reported, not touched.
- Re-checks the pointer, the broken state and the chosen index right before changing anything, and
  refuses (`NOT_SETTLED`, with a reload button) when the saved file does not match this tab.
- ✅ only after a save written after the edit holds the target or a verified successor index that
  equals the live pointer, and the live pointer has been still for 2 s (the store's first call after
  a fix writes two indexes ~1 s apart; an immediate reload must not lose the second).
- Account-storage traces (`dosync=avoid`) show a warning and preselect no recovery candidate.
- Verified on stock RisuAI v2026.10.292 (IndexedDB and OPFS databases, including clock-shifted
  "hours/days later" runs past stock's trash grace), on risuai.xyz, and with CPM PROD 1.99.16 —
  evidence in `README.md`.
