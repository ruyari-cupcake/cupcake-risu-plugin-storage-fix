// Read-only inspection of stock RisuAI web storage, with one permitted live-object edit.
// Storage formats and backend selection follow the cited stock facts in .report/core-contract.md.
const RisuPluginStorageFix = (() => {
  'use strict';

  const INDEX_TYPE = 'risu-plugin-storage-index';
  const POINTER_KEY = '_coldpluginIndex';
  const INDEX_PREFIX = '{"type":"risu-plugin-storage-index"';
  const PREFIX_READ_LIMIT = 128;
  const SAMPLE_KEY_COUNT = 8;
  // Heavy profiles take seconds per save (encode + write of the whole database), and a save that
  // was already running when the pointer changed has to finish first; a timeout only reports.
  const DEFAULT_SAVE_TIMEOUT_MS = 60000;
  const SAVE_POLL_INTERVAL_MS = 500;
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
    NOT_BROKEN: '현재 플러그인 저장소는 끊어진 인덱스를 가리키고 있지 않아요. 변경하지 않았어요.',
    CHANGED: '진단 뒤 플러그인 저장소가 달라졌어요. 다시 진단해 주세요.',
    CANDIDATE_INVALID: '복구할 인덱스를 다시 읽을 수 없어요. 다시 진단해 주세요.',
    SAVE_UNCONFIRMED: '변경은 했지만, 리스 저장 파일에 반영된 것을 1분 안에 확인하지 못했어요.',
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

  function liveStorage(env) {
    const apis = env.pluginApis();
    if (!apis || typeof apis.getDatabase !== 'function') throw new FixError('NOT_RISU');
    const storage = apis.getDatabase()?.pluginCustomStorage;
    if (!storage || typeof storage !== 'object') throw new FixError('NOT_READY');
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
    try {
      throwIfCancelled(signal);
      const fileHandle = handle || await root.getFileHandle(coldName(id));
      const file = await fileHandle.getFile();
      const bytes = await readGzip(env, file, signal, prefixOnly);
      const value = bytes && JSON.parse(new TextDecoder().decode(bytes));
      throwIfCancelled(signal);
      if (!isPluginStorageIndex(value)) return { state: 'unreadable' };
      return { state: 'healthy', index: value, lastModified: file.lastModified };
    } catch (error) {
      throwIfCancelled(signal);
      if (error?.code === 'CANCELLED') throw error;
      return { state: error?.name === 'NotFoundError' ? 'missing' : 'unreadable' };
    }
  }

  async function findCandidates(env, { excludeId, signal, onProgress } = {}) {
    throwIfCancelled(signal);
    requireWeb(env);
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
    let done = 0;
    if (onProgress) onProgress(done, files.length);
    for (const [name, handle] of files) {
      throwIfCancelled(signal);
      const id = name.slice('coldstorage_'.length, -'.json'.length);
      if (id !== excludeId) {
        const result = await readIndex(env, root, id, signal, true, handle);
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
    return candidates.sort((a, b) => b.lastModified - a.lastModified);
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
    const pointer = storage[POINTER_KEY];
    if (typeof pointer !== 'string') return { state: 'no-index', backend: 'web' };
    const root = await env.opfsRoot();
    const result = await readIndex(env, root, pointer, signal);
    if (result.state === 'healthy') return { state: 'healthy', backend: 'web', pointer, keyCount: result.index.entries.length };
    const candidates = await findCandidates(env, { excludeId: pointer, signal, onProgress });
    return { state: 'broken', backend: 'web', pointer, reason: result.state, candidates };
  }

  function checkLive(env, pointer, signal) {
    throwIfCancelled(signal);
    requireWeb(env);
    const storage = liveStorage(env);
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
    return { storage, root };
  }

  async function recover(env, { pointer, candidateId, signal, timeoutMs } = {}) {
    const { root } = await checkBroken(env, pointer, signal);
    if (typeof candidateId !== 'string' || candidateId === pointer) throw new FixError('CANDIDATE_INVALID');
    const candidate = await readIndex(env, root, candidateId, signal);
    if (candidate.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');
    // The candidate read yields: a concurrent plugin write or backend switch must still win.
    await checkBroken(env, pointer, signal);
    const storage = checkLive(env, pointer, signal);
    storage[POINTER_KEY] = candidateId;
    return await waitForPersisted(env, (saved) => saved === candidateId, { signal, timeoutMs });
  }

  async function reset(env, { pointer, signal, timeoutMs } = {}) {
    await checkBroken(env, pointer, signal);
    const storage = checkLive(env, pointer, signal);
    delete storage[POINTER_KEY];
    return await waitForPersisted(env, (saved) => saved === null, { signal, timeoutMs });
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
    if (env.localStorage.getItem('opfs_flag!') === 'able') {
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
  // Save-loop backups announce a new database write; the backup itself is never read.
  async function waitForPersisted(env, predicate, { signal, timeoutMs = DEFAULT_SAVE_TIMEOUT_MS } = {}) {
    throwIfCancelled(signal);
    requireWeb(env);
    const started = env.now();
    const location = await databaseLocation(env);
    let lastBackup = await latestBackup(env, location, signal);
    let shouldRead = true;
    while (true) {
      throwIfCancelled(signal);
      requireWeb(env);
      if (shouldRead) {
        const saved = await readAtLocation(env, location);
        throwIfCancelled(signal);
        requireWeb(env);
        // A save file without the plugin storage block reads as "no pointer"; it must never confirm a reset.
        if (saved.format === 'risusave' && saved.hasBlock && predicate(saved.pointer)) return { confirmed: true };
      }
      const remaining = timeoutMs - (env.now() - started);
      if (remaining <= 0) throw new FixError('SAVE_UNCONFIRMED');
      await env.sleep(Math.min(SAVE_POLL_INTERVAL_MS, remaining));
      throwIfCancelled(signal);
      const latest = await latestBackup(env, location, signal);
      shouldRead = latest > lastBackup;
      lastBackup = Math.max(lastBackup, latest);
    }
  }

  return { DEFAULT_SAVE_TIMEOUT_MS, SAVE_POLL_INTERVAL_MS, PREFIX_READ_LIMIT, SAMPLE_KEY_COUNT,
    FixError, createBrowserEnv, diagnose, findCandidates, recover, reset,
    readPersistedPointer, waitForPersisted };
})();

if (typeof module !== 'undefined') module.exports = RisuPluginStorageFix; // @strip-in-bundle
