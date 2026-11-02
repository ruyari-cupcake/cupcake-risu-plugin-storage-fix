# Caller map — consumers of the one value the tool changes

The tool changes exactly one stored value: `DBState.db.pluginCustomStorage._coldpluginIndex`
(set to a surviving index id, or deleted). New code has no in-repo callers; these are the stock
RisuAI (GitHub HEAD `ea61945`, v2026.10.292) readers of that value and what each relies on.
Paths are relative to `src/` of a `kwaroran/RisuAI` checkout at `ea61945`.

| Consumer | Relies on | How the tool must leave it / guarding test |
|---|---|---|
| `ts/process/pluginStorageStore.ts` `load`/`doLoad` (L124-222) | pointer is a string → item must be a valid index, else throw; absent → empty store; `loaded` false after a throw so the next call reloads | recover: pointer = an id whose OPFS item passes `isPluginStorageIndex`; reset: property absent (not `null` string). Tests: recover re-validates candidate; reset deletes the key. Live: sandbox `risuai.pluginStorage.getItem` succeeds after reload |
| same, `load` L125-135 (pointer changed outside the store) | a changed pointer while `loaded` makes it reload | only relevant if the store had loaded; refuse unless the live pointer is still broken (`NOT_BROKEN`) |
| same, `collectTrash` (L320-343) after a successful load | trash entries of the RECOVERED index are deleted once their grace passed | recovering an older index may delete its own expired trash items — stock behaviour, items not referenced by it; nothing else to do |
| `ts/process/coldstorageData.ts` `getPluginStorageIndexPointer` / `listColdDataKeysFromDb` (L101-125) | pointer is a string or absent | reset leaves it absent → backups simply omit it |
| `ts/drive/drive.ts` L468-472 (Drive/local restore second pass) | `typeof pointer === 'string'` | same |
| `ts/plugins/plugins.svelte.ts` `keepPluginStorageInternals` (L837-848) | copies `_coldpluginIndex` from the live object when a plugin writes back `pluginCustomStorage` | tool writes the live object directly, so later plugin write-backs keep the new value |
| `ts/globalApi.svelte.ts` saveDb `$effect` on `$state.snapshot(pluginCustomStorage)` (L373-377) | a deep change marks the `pluginStorage` block dirty | the property set/delete must happen on the live `$state` object (`getDatabase().pluginCustomStorage`), not on a copy. Test: persisted-pointer wait; Live: reload keeps the change |
| CPM (`_temp_repo-IPC-v2/src/lib/save-file-store.js`, v1.99.4+) | classifies only the host text `Failed to load plugin storage index` as "save store unavailable"; re-judges on next boot and backfills | after the fix + reload CPM must boot without its 🗄️ dead-store line (live check) |
