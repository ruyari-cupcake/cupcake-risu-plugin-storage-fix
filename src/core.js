// Read-only inspection of stock RisuAI web storage, with one permitted live-object edit.
// Storage formats and backend selection follow the cited stock facts in .report/core-contract.md.
const RisuPluginStorageFix = (() => {
  'use strict';

  const INDEX_TYPE = 'risu-plugin-storage-index';
  const POINTER_KEY = '_coldpluginIndex';
  const INDEX_PREFIX = '{"type":"risu-plugin-storage-index"';
  const PREFIX_READ_LIMIT = 128;
  const SAMPLE_KEY_COUNT = 8;
  const SAVE_POLL_INTERVAL_MS = 500;
  // Stock ea61945: pluginStorageStore.ts L56, L502-519 delays a call's own write after
  // the migration flush (L213-221); globalApi.svelte.ts L412-416 idles before saving.
  // Allow that base flush, the host idle, and a poll before offering immediate reload.
  // Size-dependent flush delays (up to 15 s, stock L57/L505) are not modeled here.
  const STOCK_PLUGIN_FLUSH_DELAY_MS = 1000;
  const STOCK_SAVE_IDLE_MS = 500;
  const SAVE_SETTLE_MS = STOCK_PLUGIN_FLUSH_DELAY_MS + STOCK_SAVE_IDLE_MS + SAVE_POLL_INTERVAL_MS;
  const SAVE_UNKNOWN_RETRY_COUNT = 3;
  const DATABASE_KEY = 'database/database.bin';
  const DATABASE_NAME = 'risuai';
  const OBJECT_STORE = 'keyvaluepairs';
  const SAVE_MAGIC = [82, 73, 83, 85, 83, 65, 86, 69, 0];
  const PLUGIN_STORAGE_TYPE = 11;
  const BLOCK_PREFIX_BYTES = 3;
  const LENGTH_BYTES = 4;
  const MESSAGES = {
    NOT_RISU: '리스 플러그인 API를 찾지 못했어요. 리스가 열린 탭에서 실행해 주세요.',
    NOT_READY: '리스 데이터베이스가 아직 준비되지 않았어요. 로딩이 끝난 뒤 다시 실행해 주세요.',
    UNSUPPORTED_BACKEND: '계정·노드·데스크톱 저장소는 이 도구로 고치지 않아요. 일시적인 연결 문제일 수도 있어요.',
    UNSUPPORTED_BROWSER: '이 브라우저에서는 저장소를 안전하게 확인할 수 없어요. OPFS와 gzip 읽기를 지원하는 브라우저에서 실행해 주세요.',
    UNCERTAIN: '플러그인 저장소 목차 파일을 확실하게 읽을 수 없어서 변경하지 않았어요. 다른 리스 탭을 닫고 새로고침한 뒤 다시 실행해 주세요.',
    NOT_SETTLED: '현재 탭과 저장 파일의 목차 표시가 일치하지 않아 변경하지 않았어요. 다른 리스 탭을 닫고 새로고침한 뒤 다시 실행해 주세요.',
    NOT_BROKEN: '현재 플러그인 저장소는 없는 목차를 가리키고 있지 않아요. 변경하지 않았어요.',
    CHANGED: '진단 뒤 플러그인 저장소가 달라졌어요. 다시 진단해 주세요.',
    CANDIDATE_INVALID: '되살릴 목차를 다시 읽을 수 없어요. 다시 진단해 주세요.',
    CANCELLED: '작업을 취소했어요.',
  };

  class FixError extends Error {
    constructor(code, message = MESSAGES[code]) {
      super(message);
      this.name = 'FixError';
      this.code = code;
    }
  }

  function throwIfCancelled(signal) {
    if (signal && signal.aborted) throw new FixError('CANCELLED');
  }

  // Opening an absent IDB database starts an upgrade. Abort it, never commit creation.
  // Connections are short-lived and transactions are strictly readonly.
  function createBrowserEnv(globalObj = globalThis) {
    async function openDatabase() {
      if (!globalObj.indexedDB) return null;
      return new Promise((resolve, reject) => {
        const request = globalObj.indexedDB.open(DATABASE_NAME);
        let absent = false;
        request.onupgradeneeded = () => {
          absent = true;
          request.transaction.abort();
        };
        request.onerror = (event) => {
          if (absent) {
            event.preventDefault();
            resolve(null);
          } else reject(request.error);
        };
        request.onsuccess = () => {
          const db = request.result;
          if (absent || !db.objectStoreNames.contains(OBJECT_STORE)) {
            db.close();
            resolve(null);
          } else {
            db.onversionchange = () => db.close();
            resolve(db);
          }
        };
      });
    }

    async function readStore(method, key, empty) {
      const db = await openDatabase();
      if (!db) return empty;
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(OBJECT_STORE, 'readonly');
          const store = transaction.objectStore(OBJECT_STORE);
          const request = method === 'get' ? store.get(key) : store.getAllKeys();
          let result = empty;
          request.onsuccess = () => { result = request.result ?? empty; };
          transaction.oncomplete = () => { db.close(); resolve(result); };
          transaction.onabort = transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error('IndexedDB 읽기에 실패했어요.'));
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      });
    }

    return {
      pluginApis: () => globalObj.__pluginApis__,
      get localStorage() { return globalObj.localStorage; },
      get isNode() { return Boolean(globalObj.__NODE__); },
      get isTauri() { return Boolean(globalObj.__TAURI_INTERNALS__ || globalObj.window?.__TAURI_INTERNALS__); },
      get hasOpfs() { return typeof globalObj.navigator?.storage?.getDirectory === 'function'; },
      get hasDecompression() { return typeof globalObj.DecompressionStream === 'function'; },
      get opfsWritable() { return typeof globalObj.FileSystemFileHandle?.prototype?.createWritable === 'function'; },
      opfsRoot: () => globalObj.navigator.storage.getDirectory(),
      forage: {
        keys: () => readStore('keys', undefined, []),
        getItem: (key) => readStore('get', key, null),
      },
      gunzip(input) {
        const blob = typeof input.stream === 'function' ? input : new globalObj.Blob([input]);
        return blob.stream().pipeThrough(new globalObj.DecompressionStream('gzip'));
      },
      now: () => globalObj.Date.now(),
      sleep: (ms) => new Promise((resolve) => globalObj.setTimeout(resolve, ms)),
    };
  }

  function backend(env) {
    if (env.localStorage.getItem('accountst') === 'able') return 'account';
    if (env.isNode) return 'node';
    if (env.isTauri) return 'tauri';
    return 'web';
  }

  function requireWeb(env) {
    if (backend(env) !== 'web') throw new FixError('UNSUPPORTED_BACKEND');
  }

  function missingCapability(env) {
    if (!env.hasOpfs) return 'opfs';
    if (!env.hasDecompression) return 'decompression';
    return null;
  }

  function requireBrowser(env) {
    requireWeb(env);
    if (missingCapability(env)) throw new FixError('UNSUPPORTED_BROWSER');
  }

  function liveStorage(env) {
    const apis = env.pluginApis();
    if (!apis || typeof apis.getDatabase !== 'function') throw new FixError('NOT_RISU');
    const db = apis.getDatabase();
    const storage = db?.pluginCustomStorage;
    if (!storage || typeof storage !== 'object') {
      if (Array.isArray(db?.plugins)) return null;
      throw new FixError('NOT_READY');
    }
    return storage;
  }

  // Exactly the stock acceptance rule, not a stricter version/entry-schema validator.
  function isPluginStorageIndex(value) {
    return value !== null && typeof value === 'object' && value.type === INDEX_TYPE
      && Array.isArray(value.entries) && Array.isArray(value.trash);
  }

  function coldName(id) {
    return `coldstorage_${id}.json`;
  }

  async function readGzip(env, input, signal, prefixOnly = false) {
    const stream = await env.gunzip(input);
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    let prefix = '';
    let accepted = !prefixOnly;
    let ended = false;
    try {
      while (true) {
        throwIfCancelled(signal);
        const { done, value } = await reader.read();
        throwIfCancelled(signal);
        if (done) { ended = true; break; }
        if (!accepted) {
          const needed = Math.min(PREFIX_READ_LIMIT - prefix.length, value.length);
          prefix += new TextDecoder().decode(value.subarray(0, needed));
          if (!INDEX_PREFIX.startsWith(prefix.slice(0, INDEX_PREFIX.length))) return null;
          accepted = prefix.length >= INDEX_PREFIX.length;
          if (!accepted && prefix.length >= PREFIX_READ_LIMIT) return null;
        }
        chunks.push(value);
        length += value.length;
      }
      if (!accepted) return null;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally {
      if (!ended) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function readIndex(env, root, id, signal, prefixOnly = false, handle) {
    throwIfCancelled(signal);
    let fileHandle = handle;
    if (!fileHandle) {
      try { fileHandle = await root.getFileHandle(coldName(id)); } catch (error) {
        throwIfCancelled(signal);
        if (error?.code === 'CANCELLED') throw error;
        return { state: error?.name === 'NotFoundError' ? 'missing' : 'uncertain' };
      }
    }
    let file;
    let bytes;
    try {
      file = await fileHandle.getFile();
      bytes = await readGzip(env, file, signal, prefixOnly);
    } catch (error) {
      throwIfCancelled(signal);
      if (error?.code === 'CANCELLED') throw error;
      // Stock's fflate decoder can accept bytes that DecompressionStream rejects, so a
      // decoding/access failure cannot establish that stock would lose this index too.
      return { state: 'uncertain' };
    }
    throwIfCancelled(signal);
    let value;
    try { value = bytes && JSON.parse(new TextDecoder().decode(bytes)); } catch (error) {
      return { state: 'unreadable' };
    }
    if (!isPluginStorageIndex(value)) return { state: 'unreadable' };
    return { state: 'healthy', index: value, lastModified: file.lastModified };
  }

  async function scanCandidates(env, { excludeId, signal, onProgress } = {}) {
    throwIfCancelled(signal);
    requireBrowser(env);
    const root = await env.opfsRoot();
    const files = [];
    const names = new Set();
    for await (const [name, handle] of root.entries()) {
      throwIfCancelled(signal);
      if (handle.kind !== 'file') continue;
      names.add(name);
      if (name.startsWith('coldstorage_') && name.endsWith('.json')) files.push([name, handle]);
    }
    const candidates = [];
    let uncertainCount = 0;
    let done = 0;
    if (onProgress) onProgress(done, files.length);
    for (const [name, handle] of files) {
      throwIfCancelled(signal);
      const id = name.slice('coldstorage_'.length, -'.json'.length);
      if (id !== excludeId) {
        const result = await readIndex(env, root, id, signal, true, handle);
        if (result.state === 'uncertain') uncertainCount += 1;
        if (result.state === 'healthy') {
          // Same entry filter as stock doLoad: entries without a string key are skipped there too.
          const entries = result.index.entries.filter((entry) => typeof entry?.k === 'string');
          const large = entries.filter((entry) => typeof entry.l === 'string');
          candidates.push({ id, lastModified: result.lastModified, keyCount: entries.length,
            sampleKeys: entries.slice(0, SAMPLE_KEY_COUNT).map((entry) => entry.k),
            largeCount: large.length, missingLarge: large.filter((entry) => !names.has(coldName(entry.l))).length });
        }
      }
      done += 1;
      if (onProgress) onProgress(done, files.length);
    }
    throwIfCancelled(signal);
    return { candidates: candidates.sort((a, b) => b.lastModified - a.lastModified), uncertainCount };
  }

  async function findCandidates(env, options = {}) {
    return (await scanCandidates(env, options)).candidates;
  }

  async function diagnose(env, { signal, onProgress } = {}) {
    throwIfCancelled(signal);
    let storage;
    try { storage = liveStorage(env); } catch (error) {
      if (error.code === 'NOT_RISU') return { state: 'not-risu' };
      if (error.code === 'NOT_READY') return { state: 'not-ready' };
      throw error;
    }
    const selectedBackend = backend(env);
    if (selectedBackend !== 'web') return { state: 'unsupported-backend', backend: selectedBackend };
    const missing = missingCapability(env);
    if (missing) return { state: 'unsupported-browser', backend: 'web', missing };
    const pointer = storage?.[POINTER_KEY];
    if (typeof pointer !== 'string') return { state: 'no-index', backend: 'web' };
    const root = await env.opfsRoot();
    const result = await readIndex(env, root, pointer, signal);
    if (result.state === 'healthy') return { state: 'healthy', backend: 'web', pointer, keyCount: result.index.entries.length };
    const accountHint = env.localStorage.getItem('dosync') === 'avoid';
    if (result.state === 'uncertain') return { state: 'uncertain', backend: 'web', pointer, accountHint };
    const { candidates, uncertainCount } = await scanCandidates(env, { excludeId: pointer, signal, onProgress });
    return { state: 'broken', backend: 'web', pointer, reason: result.state, candidates, uncertainCount, accountHint };
  }

  function checkLive(env, pointer, signal) {
    throwIfCancelled(signal);
    requireBrowser(env);
    const storage = liveStorage(env);
    if (!storage) throw new FixError('NOT_BROKEN');
    if (storage[POINTER_KEY] !== pointer) throw new FixError('CHANGED');
    if (typeof pointer !== 'string') throw new FixError('NOT_BROKEN');
    return storage;
  }

  async function checkBroken(env, pointer, signal) {
    checkLive(env, pointer, signal);
    const root = await env.opfsRoot();
    const current = await readIndex(env, root, pointer, signal);
    const storage = checkLive(env, pointer, signal);
    if (current.state === 'healthy') throw new FixError('NOT_BROKEN');
    if (current.state !== 'missing' && current.state !== 'unreadable') throw new FixError('UNCERTAIN');
    return { storage, root };
  }

  // Both edit paths require a settled disk snapshot and own the same pre-edit receipt baseline.
  // Recheck after the disk read: another tab/plugin may have changed the live state while it yielded.
  async function prepareEdit(env, pointer, signal) {
    await checkBroken(env, pointer, signal);
    const location = await databaseLocation(env);
    const saved = await readAtLocation(env, location);
    checkLive(env, pointer, signal);
    if (saved.format !== 'risusave' || !saved.hasBlock || saved.pointer !== pointer) throw new FixError('NOT_SETTLED');
    const { root } = await checkBroken(env, pointer, signal);
    const baseline = await latestBackup(env, location, signal);
    checkLive(env, pointer, signal);
    return { root, location, baseline };
  }

  async function acceptsPersistedPointer(env, root, saved, target, deadPointer, signal) {
    if (saved === target) return true;
    if (typeof saved !== 'string' || saved === deadPointer) return false;
    return (await readIndex(env, root, saved, signal)).state === 'healthy';
  }

  async function recover(env, { pointer, candidateId, signal, onWaiting } = {}) {
    const { root } = await checkBroken(env, pointer, signal);
    if (typeof candidateId !== 'string' || candidateId === pointer) throw new FixError('CANDIDATE_INVALID');
    const candidate = await readIndex(env, root, candidateId, signal);
    if (candidate.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');
    // The candidate read yields: a concurrent plugin write or backend switch must still win.
    const { location, baseline } = await prepareEdit(env, pointer, signal);
    const storage = checkLive(env, pointer, signal);
    const editedAt = env.now();
    storage[POINTER_KEY] = candidateId;
    return await waitForPersisted(env, (saved) => acceptsPersistedPointer(env, root, saved, candidateId, pointer, signal),
      { signal, onWaiting, location, baseline, editedAt });
  }

  async function reset(env, { pointer, signal, onWaiting } = {}) {
    const { root, location, baseline } = await prepareEdit(env, pointer, signal);
    const storage = checkLive(env, pointer, signal);
    const editedAt = env.now();
    delete storage[POINTER_KEY];
    return await waitForPersisted(env, (saved) => acceptsPersistedPointer(env, root, saved, null, pointer, signal),
      { signal, onWaiting, location, baseline, editedAt });
  }

  function toHex(text) {
    return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(text) {
    if (!/^(?:[0-9a-f]{2})+$/.test(text)) return '';
    return new TextDecoder().decode(new Uint8Array(text.match(/../g).map((pair) => parseInt(pair, 16))));
  }

  async function databaseLocation(env) {
    requireWeb(env);
    if (env.localStorage.getItem('opfs_flag!') === 'able' && env.opfsWritable) {
      // Listing keys is enough to establish absence; do not load a large IDB database just
      // to choose a backend (the stock value is a truthy Uint8Array whenever the key exists).
      const keys = await env.forage.keys();
      if (!keys.includes(DATABASE_KEY) || await env.forage.getItem('migrated')) {
        return { kind: 'opfs', root: await env.opfsRoot() };
      }
    }
    return { kind: 'idb' };
  }

  async function readBytes(source, start, end) {
    if (source instanceof Uint8Array) return source.subarray(start, end);
    return new Uint8Array(await source.slice(start, end).arrayBuffer());
  }

  function readU32(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  }

  async function parseSavedPointer(env, source) {
    const size = source instanceof Uint8Array ? source.byteLength : source.size;
    const magic = await readBytes(source, 0, SAVE_MAGIC.length);
    if (!SAVE_MAGIC.every((byte, i) => magic[i] === byte)) return { format: 'unknown' };
    let offset = SAVE_MAGIC.length;
    let hasBlock = false;
    let pointer = null;
    while (offset < size) {
      if (offset + BLOCK_PREFIX_BYTES > size) return { format: 'unknown' };
      const prefix = await readBytes(source, offset, offset + BLOCK_PREFIX_BYTES);
      const [type, compression, nameLength] = prefix;
      offset += BLOCK_PREFIX_BYTES;
      if (offset + nameLength + LENGTH_BYTES > size) return { format: 'unknown' };
      const header = await readBytes(source, offset, offset + nameLength + LENGTH_BYTES);
      const name = new TextDecoder().decode(header.subarray(0, nameLength));
      const length = readU32(header.subarray(nameLength));
      offset += nameLength + LENGTH_BYTES;
      if (offset + length > size) return { format: 'unknown' };
      if (type === PLUGIN_STORAGE_TYPE && name === 'pluginStorage') {
        let data = await readBytes(source, offset, offset + length);
        if (compression === 1) data = await readGzip(env, data);
        const storage = JSON.parse(new TextDecoder().decode(data));
        if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return { format: 'unknown' };
        hasBlock = true;
        pointer = typeof storage[POINTER_KEY] === 'string' ? storage[POINTER_KEY] : null;
      }
      offset += length;
    }
    return { format: 'risusave', hasBlock, pointer };
  }

  async function readAtLocation(env, location) {
    try {
      let source;
      if (location.kind === 'opfs') {
        const handle = await location.root.getFileHandle(toHex(DATABASE_KEY));
        source = await handle.getFile();
      } else source = await env.forage.getItem(DATABASE_KEY);
      if (!source) return { format: 'unknown' };
      return await parseSavedPointer(env, source);
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      return { format: 'unknown' };
    }
  }

  async function readPersistedPointer(env) {
    requireWeb(env);
    return await readAtLocation(env, await databaseLocation(env));
  }

  async function latestBackup(env, location, signal) {
    requireWeb(env);
    const keys = [];
    if (location.kind === 'idb') keys.push(...await env.forage.keys());
    else {
      for await (const [name, handle] of location.root.entries()) {
        throwIfCancelled(signal);
        if (handle.kind === 'file') keys.push(fromHex(name));
      }
    }
    let latest = -1;
    for (const key of keys) {
      const match = /^database\/dbbackup-(\d+)\.bin$/.exec(key);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    return latest;
  }

  // This is a receipt wait only: it never forces a save, rolls back a live edit, or retries it.
  // A new backup opens the gate, but OPFS close() may still be in flight. IDB is transactional;
  // retain its gated snapshot while the live pointer settles, replacing it on every new read
  // (even an unknown read). Only unknown IDB reads get a bounded retry budget.
  async function waitForPersisted(env, predicate, { signal, onWaiting, location, baseline, editedAt } = {}) {
    throwIfCancelled(signal);
    requireWeb(env);
    const started = env.now();
    let livePointer = liveStorage(env)?.[POINTER_KEY] ?? null;
    let lastChangeAt = editedAt ?? started;
    location = location || await databaseLocation(env);
    if (baseline === undefined) baseline = await latestBackup(env, location, signal);
    let lastBackup = baseline;
    let lastSaveSeenAt = editedAt ?? started;
    let saves = 0;
    let unknownRetries = 0;
    let saved = { format: 'unknown' };
    while (true) {
      throwIfCancelled(signal);
      requireWeb(env);
      const latest = await latestBackup(env, location, signal);
      const newer = latest > lastBackup;
      lastBackup = Math.max(lastBackup, latest);
      if (newer) {
        // Only a newer backup proves host save progress; memory-only pointer changes do not.
        lastSaveSeenAt = env.now();
        saves += 1;
        unknownRetries = SAVE_UNKNOWN_RETRY_COUNT;
      }
      const shouldRead = lastBackup > baseline && (location.kind === 'opfs' || newer || unknownRetries > 0);
      if (shouldRead) {
        if (!newer) unknownRetries -= 1;
        saved = await readAtLocation(env, location);
        throwIfCancelled(signal);
        requireWeb(env);
        if (saved.format !== 'unknown') unknownRetries = 0;
      }
      // A save without the block says nothing about the pointer, so it cannot confirm a reset.
      const accepted = saved.format === 'risusave' && saved.hasBlock && await predicate(saved.pointer);
      throwIfCancelled(signal);
      requireWeb(env);
      // Sample after all awaited reads/verification: a plugin can flush during either one.
      // Deleting the live key gives undefined, while the persisted parser reports null.
      const currentPointer = liveStorage(env)?.[POINTER_KEY] ?? null;
      if (currentPointer !== livePointer) {
        livePointer = currentPointer;
        lastChangeAt = env.now();
      }
      if (accepted && saved.pointer === livePointer && env.now() - lastChangeAt >= SAVE_SETTLE_MS) {
        return { confirmed: true, persistedPointer: saved.pointer };
      }
      const now = env.now();
      // Display failures must not turn an applied edit into a failed or replayed receipt wait.
      try {
        if (onWaiting) onWaiting({ waitedMs: now - (editedAt ?? started), sinceSaveMs: now - lastSaveSeenAt, saves });
      } catch (error) {}
      await env.sleep(SAVE_POLL_INTERVAL_MS);
    }
  }

  return { SAVE_POLL_INTERVAL_MS, PREFIX_READ_LIMIT, SAMPLE_KEY_COUNT,
    FixError, createBrowserEnv, diagnose, findCandidates, recover, reset,
    readPersistedPointer, waitForPersisted };
})();

if (typeof module !== 'undefined') module.exports = RisuPluginStorageFix; // @strip-in-bundle
