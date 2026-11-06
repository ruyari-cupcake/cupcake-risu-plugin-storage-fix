/*! 컵케익 리스 플러그인 저장소 고치기 v0.2.0 | (c) 2026 Ruyari Cupcake | MIT License | https://github.com/ruyari-cupcake/cupcake-risu-plugin-storage-fix */
(() => {
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
  /* Stock OpfsStorage.setItem replaces the database file (createWritable → write → close); a File taken from getFile()
     before that close throws NotReadableError on read (Chromium, measured 2026-11-06). The pre-edit check therefore
     reads a fresh snapshot up to this many times before it calls the profile unsettled; one save takes far less. */
  const SETTLED_READ_ATTEMPTS = 4;
  const SETTLED_READ_RETRY_MS = 250;
  const DATABASE_KEY = 'database/database.bin';
  /* Four reads balance hub scan latency against simultaneous worker load (design R4). */
  const HUB_SCAN_CONCURRENCY = 4;
  /* A second missing read must outlast a brief deletion/list race (design R2). */
  const HUB_MISSING_RECHECK_MS = 2000;
  /* Retry unresolved hub receipts without another cache save (design R5). */
  const HUB_RECHECK_BACKOFF_MS = 2000;
  /* Bound retry traffic, never the duration of the receipt wait (design R5/R32). */
  const HUB_RECHECK_MAX_MS = 60000;
  /* Stock globalApi.svelte.ts sleeps 3000 ms after an account save. */
  const STOCK_ACCOUNT_POST_SAVE_MS = 3000;
  /* Base plugin flush + account post-save sleep + host idle + one observation poll. */
  const ACCOUNT_SAVE_SETTLE_MS = STOCK_PLUGIN_FLUSH_DELAY_MS + STOCK_ACCOUNT_POST_SAVE_MS + STOCK_SAVE_IDLE_MS + SAVE_POLL_INTERVAL_MS;
  /* Three fresh rejected save observations warrant the non-terminal hub hint (design R5). */
  const HUB_REJECT_HINT_SAVES = 3;
  const ACCOUNT_DATABASE_NAME = 'risuaiAccountCached';
  const ROOT_TYPE = 1;
  const DATABASE_NAME = 'risuai';
  const OBJECT_STORE = 'keyvaluepairs';
  const SAVE_MAGIC = [82, 73, 83, 85, 83, 65, 86, 69, 0];
  const PLUGIN_STORAGE_TYPE = 11;
  const BLOCK_PREFIX_BYTES = 3;
  const LENGTH_BYTES = 4;
  const MESSAGES = {
    NOT_RISU: '리스 플러그인 API를 찾지 못했어요. 리스가 열린 탭에서 실행해 주세요.',
    NOT_READY: '리스 데이터베이스가 아직 준비되지 않았어요. 로딩이 끝난 뒤 다시 실행해 주세요.',
    UNSUPPORTED_BACKEND: '노드·데스크톱 저장소는 이 도구로 고치지 않아요. 일시적인 연결 문제일 수도 있어요.',
    UNSUPPORTED_BROWSER: '이 브라우저에서는 저장소를 안전하게 확인할 수 없어요. OPFS와 gzip 읽기를 지원하는 브라우저에서 실행해 주세요.',
    UNCERTAIN: '플러그인 저장소 목차 파일을 확실하게 읽을 수 없어서 변경하지 않았어요. 다른 리스 탭을 닫고 새로고침한 뒤 다시 실행해 주세요.',
    NOT_SETTLED: '현재 탭과 저장 파일의 목차 표시가 일치하지 않아 변경하지 않았어요. 다른 리스 탭을 닫고 새로고침한 뒤 다시 실행해 주세요.',
    NOT_BROKEN: '현재 플러그인 저장소는 없는 목차를 가리키고 있지 않아요. 변경하지 않았어요.',
    CHANGED: '진단 뒤 플러그인 저장소가 달라졌어요. 다시 진단해 주세요.',
    CANDIDATE_INVALID: '되살릴 목차를 다시 읽을 수 없어요. 다시 진단해 주세요.',
    CANCELLED: '작업을 취소했어요.',
    DEVICES_NOT_CONFIRMED: '다른 기기와 다른 탭의 리스를 모두 닫았는지 먼저 확인해 주세요. 변경하지 않았어요.',
    ACCOUNT_LOGIN: '리스가 로그인 창을 띄우면 거기서 로그인한 뒤 다시 실행해 주세요. 이 기기의 로그인으로 계정 서버를 확인하지 못했어요.',
    ACCOUNT_UNAVAILABLE: '계정 서버를 확실하게 읽을 수 없어요. 잠시 뒤 다시 확인해 주세요.',
    ACCOUNT_MISMATCH: '이 기기의 로그인과 계정 서버의 계정이 달라서 작업을 멈췄어요.',
    TARGET_GONE: '서버의 목차 표시는 바뀌었지만 되살릴 목차가 더는 서버에서 읽히지 않아요. 변경을 반복하지 않았어요. 다시 진단해 주세요.',
  };

  class FixError extends Error {
    constructor(code, message = MESSAGES[code]) {
      super(message);
      this.name = 'FixError';
      this.code = code;
      this.applied = false;
    }
  }

  function throwIfCancelled(signal) {
    if (signal && signal.aborted) throw new FixError('CANCELLED');
  }

  // Opening an absent IDB database starts an upgrade. Abort it, never commit creation.
  // Connections are short-lived and transactions are strictly readonly.
  function createBrowserEnv(globalObj = globalThis) {
    async function openDatabase(name = DATABASE_NAME) {
      if (!globalObj.indexedDB) return null;
      return new Promise((resolve, reject) => {
        const request = globalObj.indexedDB.open(name);
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

    async function readStore(method, key, empty, name = DATABASE_NAME) {
      const db = await openDatabase(name);
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
      accountCache: {
        keys: () => readStore('keys', undefined, [], ACCOUNT_DATABASE_NAME),
        getItem: (key) => readStore('get', key, null, ACCOUNT_DATABASE_NAME),
      },
      get fetch() { return typeof globalObj.fetch === 'function' ? (...args) => globalObj.fetch(...args) : undefined; },
      randomId: () => globalObj.crypto.randomUUID(),
      hubBase: () => globalObj.localStorage.getItem('hub') === 'nightly' ? 'https://nightly.sv.risuai.xyz' : 'https://sv.risuai.xyz',
      gunzip(input) {
        const blob = typeof input.stream === 'function' ? input : new globalObj.Blob([input]);
        return blob.stream().pipeThrough(new globalObj.DecompressionStream('gzip'));
      },
      now: () => globalObj.Date.now(),
      sleep: (ms) => new Promise((resolve) => globalObj.setTimeout(resolve, ms)),
    };
  }

  function backend(env) {
    if (env.isTauri) return 'tauri';
    if (env.isNode) return 'node';
    if (env.localStorage.getItem('accountst') === 'able') return 'account';
    return 'web';
  }

  /* Account transport, parser and receipt share one run-owned identity and abort scope.
     Cache bytes supply credentials only; no cache value is ever a hub receipt. */
  class AccountIssue extends Error {
    constructor(state, status = null, phase = 'db') {
      super('계정 서버를 안전하게 확인하지 못했어요.');
      this.state = state;
      this.status = status;
      this.phase = phase;
    }
  }

  function requireAccount(env, signal) {
    throwIfCancelled(signal);
    if (backend(env) !== 'account') throw new FixError('CHANGED');
    if (missingCapability(env) || typeof env.fetch !== 'function') throw new FixError('UNSUPPORTED_BROWSER');
    if (env.localStorage.getItem('ignoreRisuAuth') === 'true') throw new AccountIssue('account-auth-unknown');
  }

  function accountError(error) {
    if (!(error instanceof AccountIssue)) return error;
    const codes = { 'account-login': 'ACCOUNT_LOGIN', 'account-mismatch': 'ACCOUNT_MISMATCH',
      'account-auth-unknown': 'UNCERTAIN', 'account-unavailable': 'ACCOUNT_UNAVAILABLE' };
    return new FixError(codes[error.state] || 'ACCOUNT_UNAVAILABLE');
  }

  function credentials(value) {
    return value && typeof value.id === 'string' && typeof value.token === 'string' && value.token.length
      ? { id: value.id, token: value.token } : null;
  }

  /* Both cache and hub use the same incremental RISUSAVE reader. Skip unrelated payloads,
     discard the root after extracting identity, and cancel before character/chat blocks. */
  async function parseAccountSave(env, source, signal, rootOnly = false) {
    const stream = source instanceof Uint8Array ? new ReadableStream({
      start(controller) { controller.enqueue(source); controller.close(); },
    }) : source;
    const reader = stream.getReader();
    let pending = new Uint8Array();
    let cursor = 0;
    let ended = false;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    async function take(count, keep = true, allowEnd = false) {
      const parts = keep ? [] : null;
      let copied = 0;
      while (copied < count) {
        throwIfCancelled(signal);
        if (cursor === pending.length) {
          const part = await reader.read();
          throwIfCancelled(signal);
          if (part.done) {
            ended = true;
            if (allowEnd && copied === 0) return null;
            throw new Error('불완전한 RISUSAVE 블록');
          }
          pending = part.value;
          cursor = 0;
          if (!pending.length) continue;
        }
        const size = Math.min(count - copied, pending.length - cursor);
        if (keep) parts.push(pending.subarray(cursor, cursor + size));
        cursor += size;
        copied += size;
      }
      if (!keep) return null;
      /* Allocate only received payloads, never a possibly torn header's declared length. */
      const output = new Uint8Array(count);
      let position = 0;
      for (const part of parts) { output.set(part, position); position += part.length; }
      return output;
    }
    try {
      const magic = await take(SAVE_MAGIC.length);
      if (!SAVE_MAGIC.every((byte, i) => magic[i] === byte)) throw new Error('알 수 없는 RISUSAVE');
      let account = null;
      let hasRoot = false;
      while (true) {
        const prefix = await take(BLOCK_PREFIX_BYTES, true, true);
        if (!prefix) return { account, accountId: account?.id ?? null, hasBlock: false, pointer: null };
        const [type, compression, nameLength] = prefix;
        const header = await take(nameLength + LENGTH_BYTES);
        const name = new TextDecoder().decode(header.subarray(0, nameLength));
        const size = readU32(header.subarray(nameLength));
        const isRoot = type === ROOT_TYPE && name === 'root';
        const isStorage = type === PLUGIN_STORAGE_TYPE && name === 'pluginStorage';
        let payload = await take(size, isRoot || isStorage);
        if (!isRoot && !isStorage) continue;
        if (compression === 1) payload = await readGzip(env, payload, signal);
        else if (compression !== 0) throw new Error('알 수 없는 압축 형식');
        const text = new TextDecoder().decode(payload);
        if (isRoot) {
          const root = JSON.parse(text);
          if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('잘못된 root 블록');
          account = { id: root.account?.id ?? null,
            ...(rootOnly ? { token: typeof root.account?.token === 'string' ? root.account.token : null } : {}) };
          hasRoot = true;
          if (rootOnly) return { account };
        } else {
          if (!hasRoot) throw new Error('root 블록 없음');
          const storage = text === '' ? {} : JSON.parse(text);
          if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new Error('잘못된 목차 블록');
          return { accountId: account?.id ?? null, hasBlock: true,
            pointer: typeof storage[POINTER_KEY] === 'string' ? storage[POINTER_KEY] : null };
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!ended) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function accountSources(env, signal) {
    const sources = [];
    try {
      const bytes = await env.accountCache.getItem(DATABASE_KEY);
      throwIfCancelled(signal);
      if (bytes instanceof Uint8Array) {
        const cached = credentials((await parseAccountSave(env, bytes, signal, true)).account);
        if (cached) sources.push({ ...cached, source: 'cache' });
      }
    } catch (error) { throwIfCancelled(signal); }
    try {
      const fallback = credentials(JSON.parse(env.localStorage.getItem('fallbackRisuToken')));
      /* Stock Logout keeps the old cache; a different current login owns this run. */
      if (fallback && sources[0]?.id !== fallback.id) sources.length = 0;
      if (fallback) sources.push({ ...fallback, source: 'fallback' });
    } catch (error) {}
    throwIfCancelled(signal);
    return sources;
  }

  async function withAccountRun(env, signal, operation) {
    requireAccount(env, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const sources = await accountSources(env, controller.signal);
      requireAccount(env, controller.signal);
      if (!sources.length) throw new AccountIssue('account-login');
      return await operation({ env, controller, signal: controller.signal, sources, accepted: null, hub: env.hubBase() });
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  async function cancelBody(response) {
    await response?.body?.cancel().catch(() => {});
  }

  async function hubRequest(run, key, phase, requestSignal = run.signal) {
    const { env } = run;
    requireAccount(env, run.signal);
    throwIfCancelled(requestSignal);
    const sources = run.accepted ? [run.accepted] : run.sources;
    for (const source of sources) {
      let response;
      try {
        const database = key === DATABASE_KEY;
        const url = database ? `${run.hub}/api/account/read/${toHex(DATABASE_KEY)}|${env.randomId()}`
          : `${run.hub}/hub/account/coldstorage`;
        response = await env.fetch(url, { method: 'GET', cache: 'no-store', signal: requestSignal,
          headers: { 'x-risu-auth': source.token, 'x-risu-key': key, ...(database ? { 'x-risu-save-date': '0' } : {}) } });
      } catch (error) {
        throwIfCancelled(run.signal);
        throwIfCancelled(requestSignal);
        throw new AccountIssue('account-unavailable', null, phase);
      }
      if (requestSignal.aborted || run.signal.aborted) {
        await cancelBody(response);
        throwIfCancelled(run.signal);
        throwIfCancelled(requestSignal);
      }
      if (response.status === 403) {
        await cancelBody(response);
        if (phase === 'scan') return response;
        continue;
      }
      if (!run.accepted && response.status === 200) run.accepted = source;
      return response;
    }
    throw new AccountIssue('account-login');
  }

  async function readHubDatabase(run) {
    const response = await hubRequest(run, DATABASE_KEY, 'db');
    if (response.status !== 200) {
      await cancelBody(response);
      throw new AccountIssue('account-unavailable', response.status, 'db');
    }
    let saved;
    try {
      saved = await parseAccountSave(run.env, response.body, run.signal);
      if (!saved.hasBlock) throw new Error('목차 블록 없음');
    } catch (error) {
      throwIfCancelled(run.signal);
      throw new AccountIssue('account-unavailable', null, 'db');
    }
    requireAccount(run.env, run.signal);
    if (saved.accountId !== null && saved.accountId !== run.accepted.id) throw new AccountIssue('account-mismatch');
    return saved;
  }

  async function readHubKeys(run) {
    const response = await hubRequest(run, '@list-keys', 'list');
    if (response.status !== 200) {
      await cancelBody(response);
      throw new AccountIssue('account-unavailable', response.status, 'list');
    }
    try {
      const listed = await new Response(response.body).json();
      throwIfCancelled(run.signal);
      if (!Array.isArray(listed?.items) || listed.items.some((item) => typeof item !== 'string')) throw new Error('잘못된 목록');
      return new Set(listed.items);
    } catch (error) {
      throwIfCancelled(run.signal);
      throw new AccountIssue('account-unavailable', null, 'list');
    }
  }

  async function readHubIndex(run, id, { prefix = false, phase = 'index', signal = run.signal } = {}) {
    const response = await hubRequest(run, id, phase, signal);
    if (response.status !== 200) {
      await cancelBody(response);
      return { state: 'status', status: response.status };
    }
    let decoded;
    try { decoded = await readGzip(run.env, { stream: () => response.body }, signal, prefix); }
    catch (error) {
      throwIfCancelled(signal);
      await cancelBody(response);
      return { state: 'uncertain', status: 200 };
    }
    throwIfCancelled(signal);
    if (decoded === null) return { state: 'non-index' };
    try {
      const value = JSON.parse(new TextDecoder().decode(decoded));
      return isPluginStorageIndex(value) ? { state: 'healthy', index: value } : { state: 'unreadable', status: 200 };
    } catch (error) { return { state: 'unreadable', status: 200 }; }
  }

  /* A single 404 is not proof of absence. A listed or changed item is never repaired;
     stock's local fallback is relevant to diagnosis/preflight, not hub receipt validity. */
  async function accountIndex(run, id, localFallback = true) {
    const initial = await readHubIndex(run, id);
    if (initial.state !== 'status') return initial;
    if (initial.status !== 404) throw new AccountIssue('account-unavailable', initial.status, 'index');
    const names = await readHubKeys(run);
    if (names.has(id)) throw new AccountIssue('account-unavailable', 404, 'index');
    await run.env.sleep(HUB_MISSING_RECHECK_MS);
    throwIfCancelled(run.signal);
    const second = await readHubIndex(run, id);
    if (second.state !== 'status' || second.status !== 404) {
      throw new AccountIssue('account-unavailable', second.status ?? 200, 'index');
    }
    if (!localFallback) return { state: 'missing' };
    let root;
    try { root = await run.env.opfsRoot(); }
    catch (error) { throwIfCancelled(run.signal); return { state: 'uncertain', status: null }; }
    const local = await readIndex(run.env, root, id, run.signal);
    return local.state === 'healthy' ? { ...local, state: 'local-only' } : local;
  }

  function accountCandidate(id, value, names) {
    const rows = value.entries.filter((item) => typeof item?.k === 'string');
    const largeRows = rows.filter((item) => typeof item.l === 'string');
    const times = value.trash.filter((item) => item?.index === true && Number.isFinite(item.at)).map((item) => item.at);
    return { id, flushedAt: times.length ? times.reduce((a, b) => Math.max(a, b)) : null,
      keyCount: rows.length, sampleKeys: rows.slice(0, SAMPLE_KEY_COUNT).map((item) => item.k),
      largeCount: largeRows.length, missingLarge: largeRows.filter((item) => !names.has(item.l)).length };
  }

  async function scanHubCandidates(run, { excludeId, onProgress } = {}) {
    const names = await readHubKeys(run);
    const ids = [...names].filter((id) => id !== excludeId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.signal.addEventListener('abort', abort, { once: true });
    const candidates = [];
    let uncertainCount = 0;
    let cursor = 0;
    let completed = 0;
    let failure;
    if (onProgress) onProgress(0, ids.length);
    async function worker() {
      while (!failure && cursor < ids.length) {
        throwIfCancelled(run.signal);
        const id = ids[cursor++];
        try {
          const item = await readHubIndex(run, id, { prefix: true, phase: 'scan', signal: controller.signal });
          if (item.state === 'status') throw new AccountIssue('account-unavailable', item.status, 'scan');
          if (item.state === 'healthy') candidates.push(accountCandidate(id, item.index, names));
          if (item.state === 'uncertain') uncertainCount += 1;
          completed += 1;
          if (onProgress) onProgress(completed, ids.length);
        } catch (error) {
          if (!failure) failure = error;
          controller.abort();
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(HUB_SCAN_CONCURRENCY, ids.length) }, worker));
      throwIfCancelled(run.signal);
      if (failure) throw failure;
      return { candidates: candidates.sort((a, b) => {
        if (a.flushedAt !== b.flushedAt) return a.flushedAt === null ? 1 : b.flushedAt === null ? -1 : b.flushedAt - a.flushedAt;
        return b.keyCount - a.keyCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      }), uncertainCount };
    } finally {
      run.signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  async function diagnoseAccount(env, storage, { signal, onProgress }) {
    const pointer = typeof storage?.[POINTER_KEY] === 'string' ? storage[POINTER_KEY] : null;
    try {
      return await withAccountRun(env, signal, async (run) => {
        const saved = await readHubDatabase(run);
        const livePointer = liveStorage(env)?.[POINTER_KEY];
        if (saved.pointer !== pointer || (typeof livePointer === 'string' ? livePointer : null) !== pointer) {
          return { state: 'account-not-settled', backend: 'account', pointer };
        }
        if (pointer === null) return { state: 'no-index', backend: 'account' };
        const current = await accountIndex(run, pointer);
        if (current.state === 'healthy' || current.state === 'local-only') {
          return { state: current.state, backend: 'account', pointer, keyCount: current.index.entries.length };
        }
        if (current.state === 'uncertain') return { state: 'uncertain', backend: 'account', pointer };
        const scanned = await scanHubCandidates(run, { excludeId: pointer, onProgress });
        return { state: 'broken', backend: 'account', pointer, reason: current.state, ...scanned };
      });
    } catch (error) {
      if (!(error instanceof AccountIssue)) throw error;
      return { state: error.state, backend: 'account', ...(error.state === 'account-unavailable'
        ? { status: error.status, phase: error.phase } : {}) };
    }
  }

  function accountLive(run, pointer) {
    requireAccount(run.env, run.signal);
    if (run.env.hubBase() !== run.hub) throw new FixError('CHANGED');
    const storage = liveStorage(run.env);
    if (!storage || typeof pointer !== 'string') throw new FixError('NOT_BROKEN');
    if (storage[POINTER_KEY] !== pointer) throw new FixError('CHANGED');
    return storage;
  }

  async function accountBroken(run, pointer) {
    accountLive(run, pointer);
    const current = await accountIndex(run, pointer);
    accountLive(run, pointer);
    if (current.state === 'healthy' || current.state === 'local-only') throw new FixError('NOT_BROKEN');
    if (!['missing', 'unreadable'].includes(current.state)) throw new FixError('UNCERTAIN');
  }

  async function accountSettled(run, pointer) {
    const saved = await readHubDatabase(run);
    accountLive(run, pointer);
    if (saved.pointer !== pointer) throw new FixError('NOT_SETTLED');
  }

  async function accountTarget(run, candidateId, pointer) {
    if (typeof candidateId !== 'string' || candidateId === pointer) throw new FixError('CANDIDATE_INVALID');
    const target = await readHubIndex(run, candidateId);
    if (target.state === 'status' && target.status !== 404) throw new AccountIssue('account-unavailable', target.status, 'index');
    if (target.state !== 'healthy') throw new FixError('CANDIDATE_INVALID');
  }

  async function accountDate(run) {
    try { return await run.env.accountCache.getItem(DATABASE_KEY + '__date'); }
    catch (error) { throwIfCancelled(run.signal); return null; }
  }

  function confirmDevices(devicesClosed) {
    if (devicesClosed !== true) throw new FixError('DEVICES_NOT_CONFIRMED');
  }

  async function editAccount(env, { pointer, candidateId, signal, onWaiting, onProgress }, recovering) {
    let applied = false;
    try {
      return await withAccountRun(env, signal, async (run) => {
        accountLive(run, pointer);
        await accountSettled(run, pointer);
        await accountBroken(run, pointer);
        await scanHubCandidates(run, { excludeId: pointer, onProgress });
        if (recovering) await accountTarget(run, candidateId, pointer);
        /* Re-read across the scan/candidate awaits: neither a stale auth source nor a
           foreign save may authorize the live edit. The baseline belongs before it. */
        await accountSettled(run, pointer);
        await accountBroken(run, pointer);
        if (recovering) await accountTarget(run, candidateId, pointer);
        const currentSources = await accountSources(env, run.signal);
        if (!currentSources.some((item) => item.source === run.accepted.source && item.id === run.accepted.id && item.token === run.accepted.token)) {
          throw new FixError('CHANGED');
        }
        const baseline = await accountDate(run);
        const storage = accountLive(run, pointer);
        const editedAt = env.now();
        const target = recovering ? candidateId : null;
        if (recovering) storage[POINTER_KEY] = target;
        else delete storage[POINTER_KEY];
        applied = true;
        return await waitForAccountPersisted(run, { signal: run.signal, onWaiting, baseline, editedAt, target, deadPointer: pointer });
      });
    } catch (error) {
      const failure = accountError(error);
      /* Preserve the live-edit boundary after mapping transport issues to public errors. */
      if (applied && failure.code !== 'CANCELLED') failure.applied = true;
      throw failure;
    }
  }

  /* Triggered by cache dates, settle close, or capped exponential backoff. Each acceptance
     round downloads a new hub DB and validates the index there; no retained receipt exists. */
  async function waitForAccountPersisted(run, { onWaiting, baseline, editedAt, target, deadPointer, predicate } = {}) {
    const { env, signal } = run;
    const startAt = editedAt ?? env.now();
    let quietPointer = liveStorage(env)?.[POINTER_KEY] ?? null;
    let quietSince = startAt;
    let checkedWindow = null;
    let date = baseline === undefined ? await accountDate(run) : baseline;
    let saveSeenAt = startAt;
    let saves = 0;
    let rejected = 0;
    let backoff = HUB_RECHECK_BACKOFF_MS;
    let nextReadAt = startAt + backoff;
    function sampleLive() {
      requireAccount(env, signal);
      if (env.hubBase() !== run.hub) throw new FixError('CHANGED');
      const value = liveStorage(env)?.[POINTER_KEY] ?? null;
      if (value !== quietPointer) {
        quietPointer = value;
        quietSince = env.now();
        checkedWindow = null;
      }
    }
    while (true) {
      sampleLive();
      const observedDate = await accountDate(run);
      sampleLive();
      const newDate = observedDate !== null && observedDate !== date;
      if (newDate) {
        date = observedDate;
        saves += 1;
        saveSeenAt = env.now();
        backoff = HUB_RECHECK_BACKOFF_MS;
      }
      const windowClosed = env.now() - quietSince >= ACCOUNT_SAVE_SETTLE_MS;
      const settleRead = windowClosed && checkedWindow !== quietSince;
      if (newDate || settleRead || env.now() >= nextReadAt) {
        const readStarted = env.now();
        const readWindow = quietSince;
        if (windowClosed) checkedWindow = readWindow;
        let snapshot;
        try {
          snapshot = await readHubDatabase(run);
          sampleLive();
          if (newDate) rejected = snapshot.pointer === deadPointer ? rejected + 1 : 0;
          /* The DB read itself must start after this pointer's quiet window, not merely
             finish after it. Re-sample again after index validation, which also yields. */
          if (snapshot.pointer === quietPointer && readWindow === quietSince
            && readStarted - quietSince >= ACCOUNT_SAVE_SETTLE_MS) {
            let accepted = false;
            if (predicate) {
              accepted = await predicate(snapshot.pointer);
              if (accepted && typeof snapshot.pointer === 'string') {
                accepted = (await accountIndex(run, snapshot.pointer, false)).state === 'healthy';
              }
            } else if (snapshot.pointer === null) accepted = target === null;
            else if (snapshot.pointer !== deadPointer) {
              const fresh = await accountIndex(run, snapshot.pointer, false);
              accepted = fresh.state === 'healthy';
              if (snapshot.pointer === target && ['missing', 'unreadable'].includes(fresh.state)) throw new FixError('TARGET_GONE');
            }
            sampleLive();
            if (accepted && snapshot.pointer === quietPointer && readWindow === quietSince
              && env.now() - quietSince >= ACCOUNT_SAVE_SETTLE_MS) {
              return { confirmed: true, persistedPointer: snapshot.pointer };
            }
          }
        } catch (error) {
          throwIfCancelled(signal);
          if (!(error instanceof AccountIssue) || error.state !== 'account-unavailable') throw error;
          if (newDate) rejected = 0;
        }
        nextReadAt = env.now() + backoff;
        backoff = Math.min(HUB_RECHECK_MAX_MS, backoff * 2);
      }
      sampleLive();
      const polledAt = env.now();
      try {
        if (onWaiting) onWaiting({ waitedMs: polledAt - startAt, sinceSaveMs: polledAt - saveSeenAt, saves,
          hubRejecting: rejected >= HUB_REJECT_HINT_SAVES });
      } catch (displayError) {}
      await env.sleep(SAVE_POLL_INTERVAL_MS);
    }
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
    const abortRead = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abortRead, { once: true });
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
      signal?.removeEventListener('abort', abortRead);
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
    if (backend(env) === 'account') {
      try {
        return await withAccountRun(env, options.signal, async (run) => {
          await readHubDatabase(run);
          return (await scanHubCandidates(run, options)).candidates;
        });
      } catch (error) { throw accountError(error); }
    }
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
    if (selectedBackend === 'node' || selectedBackend === 'tauri') return { state: 'unsupported-backend', backend: selectedBackend };
    const missing = missingCapability(env) || (selectedBackend === 'account' && typeof env.fetch !== 'function' ? 'fetch' : null);
    if (missing) return { state: 'unsupported-browser', backend: selectedBackend, missing };
    if (selectedBackend === 'account') return await diagnoseAccount(env, storage, { signal, onProgress });
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
    let read = await readSaved(env, location);
    for (let attempt = 1; read.replaced && attempt < SETTLED_READ_ATTEMPTS; attempt += 1) {
      await env.sleep(SETTLED_READ_RETRY_MS);
      throwIfCancelled(signal);
      read = await readSaved(env, location);
    }
    const { saved } = read;
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

  async function recover(env, { pointer, candidateId, signal, onWaiting, onProgress, devicesClosed } = {}) {
    if (backend(env) === 'account') {
      confirmDevices(devicesClosed);
      return await editAccount(env, { pointer, candidateId, signal, onWaiting, onProgress }, true);
    }
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

  async function reset(env, { pointer, signal, onWaiting, onProgress, devicesClosed } = {}) {
    if (backend(env) === 'account') {
      confirmDevices(devicesClosed);
      return await editAccount(env, { pointer, signal, onWaiting, onProgress }, false);
    }
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

  /* `replaced`: the read failed because stock swapped the file under the snapshot (NotReadableError) — a transient,
     unlike a missing, foreign or damaged file, which reads the same way every time. */
  async function readSaved(env, location) {
    try {
      let source;
      if (location.kind === 'opfs') {
        const handle = await location.root.getFileHandle(toHex(DATABASE_KEY));
        source = await handle.getFile();
      } else source = await env.forage.getItem(DATABASE_KEY);
      if (!source) return { saved: { format: 'unknown' }, replaced: false };
      return { saved: await parseSavedPointer(env, source), replaced: false };
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      return { saved: { format: 'unknown' }, replaced: error?.name === 'NotReadableError' };
    }
  }

  async function readAtLocation(env, location) {
    return (await readSaved(env, location)).saved;
  }

  async function readPersistedPointer(env) {
    if (backend(env) === 'account') {
      try {
        return await withAccountRun(env, undefined, async (run) => {
          const result = await readHubDatabase(run);
          return { format: 'risusave', hasBlock: result.hasBlock, pointer: result.pointer };
        });
      } catch (error) { throw accountError(error); }
    }
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
    if (backend(env) === 'account') {
      try {
        return await withAccountRun(env, signal, async (run) => {
          await readHubDatabase(run);
          return await waitForAccountPersisted(run, { predicate, onWaiting, baseline, editedAt });
        });
      } catch (error) { throw accountError(error); }
    }
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

  return { SAVE_POLL_INTERVAL_MS, SETTLED_READ_RETRY_MS, PREFIX_READ_LIMIT, SAMPLE_KEY_COUNT,
    FixError, createBrowserEnv, backend, diagnose, findCandidates, recover, reset,
    readPersistedPointer, waitForPersisted };
})();


// On-page panel for the plugin storage fix. Concatenated after core.js by scripts/build.cjs, so
// `RisuPluginStorageFix` is in scope. Everything renders inside a shadow root so Risu styles
// cannot leak in, and running the bookmarklet again replaces the previous panel.
// Dynamic text (plugin key names come from plugin-controlled storage) is only ever set through
// textContent, never interpolated into innerHTML.
const RPF_VERSION = '0.2.0';
const RPF_PANEL_ID = 'cupcake-risu-plugin-storage-fix';
const RPF_PROGRESS_INTERVAL_MS = 200;
/* A save receipt longer than this gets a visible "still waiting" line (typical receipts take a few seconds). */
const RPF_SLOW_SAVE_NOTICE_MS = 10000;
/* After this long without a new host save the waiting line adds the other-tab case (stock's own alert). */
const RPF_SAVE_STALL_HINT_MS = 60000;

const RPF_STYLE = `
  :host { all: initial; }
  .panel {
    position: fixed; z-index: 2147483647; top: 16px; right: 16px;
    width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
    box-sizing: border-box; padding: 16px; border-radius: 14px;
    background: #fffaf3; color: #3b2a1f; border: 1px solid #e8cfb4;
    box-shadow: 0 12px 32px rgba(59, 42, 31, 0.28);
    font: 14px/1.55 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h2 { margin: 0; font-size: 16px; }
  .version { font-size: 11px; color: #9a7b63; font-weight: normal; }
  button {
    font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid #d9b896;
    background: #f5e3cf; color: #3b2a1f; padding: 8px 14px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: #c8763b; border-color: #b0652f; color: #fff; }
  button.danger { background: #a3402a; border-color: #8a3320; color: #fff; }
  .close { padding: 2px 10px; background: transparent; border: none; font-size: 18px; }
  p { margin: 8px 0; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  .status { margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
  .error { color: #a3402a; }
  .ok { color: #2f6b3a; }
  .warn { color: #a3402a; font-weight: 600; }
  .tabs { margin-top: 8px; padding: 6px 10px; border-radius: 8px; background: #f5e3cf; font-size: 13px; }
  .alert { margin-top: 10px; padding: 10px; border: 1px solid #e3a58f; border-radius: 10px; background: #fdf0ea; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .note { font-size: 12px; color: #7a5f4b; margin-top: 12px; }
  .candidate { display: flex; gap: 8px; align-items: flex-start; padding: 8px; margin-top: 6px;
    border: 1px solid #e8cfb4; border-radius: 10px; cursor: pointer; }
  .candidate input { margin-top: 4px; }
  .candidate .keys { font-size: 12px; color: #7a5f4b; word-break: break-all; }
  .confirm { margin-top: 12px; padding: 10px; border: 1px solid #e3a58f; border-radius: 10px; background: #fdf0ea; }
  label.check { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; cursor: pointer; }
  [hidden] { display: none !important; }
`;

const RPF_BACKEND_TEXT = {
  node: [
    '자체 서버(노드) 리스는 이 도구가 지원하지 않아요 (Risu 계정 저장을 켜 둔 경우도 마찬가지예요).',
    '아무것도 바꾸지 않았어요.',
  ].join('\n'),
  tauri: '데스크톱 앱은 이 도구가 지원하지 않아요. 아무것도 바꾸지 않았어요.',
};

const RPF_BROWSER_TEXT = {
  opfs: [
    '이 주소에서는 도구가 브라우저 저장소(OPFS)를 읽을 수 없어요. 보통 http:// 로 연 사설 주소에서 이래요.',
    'https:// 주소나 localhost로 연 리스에서 다시 실행해 주세요. 아무것도 바꾸지 않았어요.',
  ].join('\n'),
  decompression: '이 브라우저는 도구에 필요한 기능(압축 풀기)을 지원하지 않아요. 최신 크롬·엣지·파이어폭스·사파리에서 실행해 주세요. 아무것도 바꾸지 않았어요.',
  fetch: '이 브라우저에서는 도구가 계정 서버에 물어볼 수 없어요 (fetch 기능 없음). 최신 크롬·엣지·파이어폭스·사파리에서 실행해 주세요. 아무것도 바꾸지 않았어요.',
};

const RPF_ACCOUNT_HINT = '이 브라우저에서 Risu 계정 저장을 쓰다가 로그아웃했거나 동기화를 끈 흔적이 있어요. '
  + '그렇다면 최신 플러그인 데이터는 계정 쪽에 남아 있을 수 있어요 (로그아웃한 상태에서는 이 도구가 계정 쪽을 확인할 수 없어요. '
  + '다시 로그인해 계정 데이터를 불러온 뒤 이 도구를 실행하면 계정 서버 쪽을 확인해요). '
  + '이 도구로 무언가를 바꾸기 전에, 설정의 Risu 계정에서 다시 로그인해 계정 데이터를 불러오는 것부터 해 보세요.';

/*
 * Account mode (Risu account sync). The tool asks the account server what stock asks it, with the login this device keeps,
 * and changes nothing unless the server clearly says the index is gone. Advice never points at Settings → Account: with an
 * account set, that page shows Logout, which turns account saving off (stock unMigrationAccount). Re-login happens through
 * stock's own login box, which appears after a reload when the login is no longer accepted.
 */
const RPF_ACCOUNT_RELOAD_LOGIN = '리스를 새로고침해 주세요. 리스가 로그인 창을 띄우면 거기서 로그인한 뒤 이 도구를 다시 실행하면 돼요.';
const RPF_ACCOUNT_UNAVAILABLE_PHASE = {
  db: '계정 서버에서 저장 파일을 읽지 못했어요',
  index: '계정 서버에서 플러그인 저장소 목차를 읽지 못했어요',
  list: '계정 서버에서 저장된 항목 목록을 받지 못했어요',
  scan: '계정 서버의 항목을 끝까지 확인하지 못했어요',
};

/* The panel line for each account-only state, and the buttons that go with it. Pure, so tests can check every wording. */
function rpfAccountStatus(result) {
  if (result.state === 'healthy') {
    return { tone: 'ok', buttons: ['reload'], text: `✅ 계정 서버에서 지금은 플러그인 저장소 목차를 읽을 수 있어요 (값 ${result.keyCount}개).\n`
      + '오류가 났을 때는 서버가 잠깐 응답하지 않았던 것 같아요. 새로고침하면 플러그인들이 다시 읽어 와요. 아무것도 바꾸지 않았어요.' };
  }
  if (result.state === 'local-only') {
    return { tone: 'error', buttons: ['rerun'], text: '⚠ 계정 서버에는 이 플러그인 저장소 목차가 없고, 이 기기에 남아 있던 예전 사본만 있어요.\n'
      + '그래서 이 기기에서는 읽히지만, 같은 계정의 다른 기기에서는 "Failed to load plugin storage index" 오류가 나요.\n'
      + '이 기기에서 플러그인이 값을 한 번 저장하면 리스가 새 목차를 서버에 올려서 다른 기기도 다시 읽게 돼요 '
      + '(크기가 큰 값은 다른 기기에서 빈 값으로 읽힐 수 있어요). 이 도구는 아무것도 바꾸지 않았어요.' };
  }
  if (result.state === 'account-login') {
    return { tone: 'error', buttons: ['reload'], text: '❌ 이 기기의 Risu 계정 로그인을 계정 서버가 받아 주지 않아요.\n'
      + `${RPF_ACCOUNT_RELOAD_LOGIN}\n로그인 창이 뜨지 않고 리스가 평소처럼 동작하면, 이 도구가 이 기기의 로그인 정보를 쓸 수 없는 상태라 확인할 수 없어요. 아무것도 바꾸지 않았어요.` };
  }
  if (result.state === 'account-auth-unknown') {
    return { tone: 'error', buttons: [], text: '❌ 이 리스는 계정 서버에 다른 방식으로 로그인하고 있어서, 이 도구가 계정 서버를 확인할 수 없어요. 아무것도 바꾸지 않았어요.' };
  }
  if (result.state === 'account-mismatch') {
    return { tone: 'error', buttons: ['reload', 'rerun'], text: '❌ 이 도구가 찾은 로그인 정보와 리스 저장 파일의 계정이 서로 달라요. 잘못 고칠 수 있어서 아무것도 바꾸지 않았어요.\n'
      + RPF_ACCOUNT_RELOAD_LOGIN };
  }
  if (result.state === 'account-unavailable') {
    const what = RPF_ACCOUNT_UNAVAILABLE_PHASE[result.phase] || RPF_ACCOUNT_UNAVAILABLE_PHASE.db;
    const code = typeof result.status === 'number' ? ` (응답 ${result.status})` : '';
    return { tone: 'error', buttons: ['rerun'], text: `❌ ${what}${code}.\n`
      + '서버가 잠깐 바쁘거나 연결이 끊긴 것 같아요. 확인을 끝까지 하지 못하면 이 도구는 아무것도 바꾸지 않아요. 잠시 뒤 "다시 확인"을 눌러 주세요.' };
  }
  if (result.state === 'account-not-settled') {
    /* Two causes. Another device/tab saved: a reload fixes it. Or the account server refuses THIS device's saves: stock still
       writes its local copy, and after a reload the hub answers "match" to that newer date, so stock shows the refused copy
       here and a reload changes nothing — the user needs RisuAI saving again (its own warning or login box) first. */
    return { tone: 'error', buttons: ['reload', 'rerun'], text: '⚠ 계정 서버에 저장된 목차 표시와 이 탭의 표시가 달라요. 아무것도 바꾸지 않았어요.\n'
      + '다른 기기나 탭이 그사이 저장했을 수 있어요: 다른 기기와 탭의 리스를 닫고, 이 탭을 새로고침한 뒤 다시 실행해 주세요.\n'
      + '새로고침한 뒤에도 같은 문구가 나오면, 계정 서버가 이 기기의 저장을 받지 않고 있는 거예요 (리스는 이 기기에 남은 사본을 보여 줘서 '
      + '여기서는 멀쩡해 보여도, 다른 기기는 서버의 표시를 읽어요). 리스가 띄운 계정 경고나 로그인 창이 있으면 먼저 처리하고, '
      + '리스가 다시 저장할 수 있게 된 뒤에 이 도구를 실행해 주세요.' };
  }
  return null;
}

/*
 * Panel line after a failed repair. Core marks an error `applied` when it came AFTER the live pointer edit (account receipt:
 * login refused, another account's file, account settings changed, target vanished): this tab already holds the change but
 * the server save was never confirmed. Several core messages say "변경하지 않았어요", so an applied error never shows the
 * core message (TARGET_GONE's is already worded for after the edit). Pure, so tests can check every wording.
 */
const RPF_APPLIED_NOTE = '이 탭에는 이미 바꾼 표시가 들어가 있어요. 다만 계정 서버에 저장된 것까지는 확인하지 못했어요.';
const RPF_APPLIED_REASON = {
  ACCOUNT_LOGIN: '계정 서버가 이 기기의 로그인을 더는 받아 주지 않아요.',
  ACCOUNT_MISMATCH: '계정 서버의 저장 파일이 다른 계정의 것으로 바뀌었어요.',
  CHANGED: '확인하는 사이 리스의 계정 저장 상태나 연결된 서버가 바뀌었어요.',
};
const RPF_APPLIED_AGAIN = '"지금 새로고침"을 누른 뒤 이 도구를 다시 실행하면, 계정 서버에 저장됐는지 처음부터 다시 확인해요.';

function rpfRepairErrorView(error, isFixError, fallbackText) {
  const code = isFixError ? error.code : null;
  /* Core marks ANY error escaping after the edit, an unexpected (non-FixError) one included, so `applied` is honoured
     whatever the error class; an unexpected error keeps its own detail as the reason line. */
  if (error && error.applied === true) {
    if (code === 'TARGET_GONE') {
      return { tone: 'error', buttons: ['reload', 'rerun'], text: `⚠ ${error.message}\n${RPF_APPLIED_NOTE}\n${RPF_APPLIED_AGAIN}` };
    }
    const reason = RPF_APPLIED_REASON[code] || (isFixError ? '계정 서버에서 고친 결과를 확실하게 읽지 못했어요.' : fallbackText);
    const again = code === 'ACCOUNT_LOGIN' ? RPF_ACCOUNT_RELOAD_LOGIN : RPF_APPLIED_AGAIN;
    return { tone: 'error', buttons: ['reload', 'rerun'], text: `⚠ ${reason}\n${RPF_APPLIED_NOTE}\n${again}` };
  }
  if (code === 'NOT_SETTLED' || code === 'UNCERTAIN') {
    return { tone: 'error', buttons: ['reload', 'rerun'],
      text: `⚠ ${error.message}\n"지금 새로고침"을 누른 뒤 이 도구를 다시 실행해 주세요. "다시 확인"만 누르면 같은 상태로 다시 확인하게 돼요.` };
  }
  if (code === 'TARGET_GONE') {
    return { tone: 'error', buttons: ['reload', 'rerun'],
      text: `⚠ ${error.message}\n"지금 새로고침"을 누른 뒤 이 도구를 다시 실행해 주세요. 남아 있는 다른 시점이 있으면 다시 보여 줘요.` };
  }
  if (code === 'ACCOUNT_LOGIN') {
    return { tone: 'error', buttons: ['reload', 'rerun'], text: `❌ ${error.message}\n${RPF_ACCOUNT_RELOAD_LOGIN}` };
  }
  return { tone: 'error', buttons: ['rerun'], text: `❌ ${fallbackText}` };
}

/* Every device on the account loads what this one saves, so the repair waits until the user says the others are closed. */
const RPF_DEVICE_GATE_TEXT = '다른 기기(휴대폰·다른 컴퓨터)와 다른 탭에 열려 있는 리스를 모두 닫았어요.';
const RPF_DEVICE_GATE_WHY = '계정 모드에서는 고친 내용이 이 계정을 쓰는 모든 기기에 반영돼요. 고치기 전에 열려 있던 다른 기기나 탭이 나중에 저장하면 '
  + '고장 난 표시를 다시 올려서 되돌릴 수 있어요.';

function rpfFormatTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (error) {
    return String(ms);
  }
}

function rpfErrorText(error) {
  if (error instanceof RisuPluginStorageFix.FixError) return error.message;
  return `예상하지 못한 오류가 났어요: ${error && error.message ? error.message : error}`;
}

function rpfParagraph(text, className = '') {
  const node = document.createElement('p');
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

/*
 * The save receipt's waiting line. The tool never gives up on its own: RisuAI gives no "still saving"
 * signal, and one save can take minutes (a big database on a slow device, or a full re-encode after
 * legacy values migrate). After RPF_SLOW_SAVE_NOTICE_MS the panel says how long it has waited; once
 * RPF_SAVE_STALL_HINT_MS pass without a newer save it adds the one case where waiting cannot help —
 * another tab took the save, which stock itself announces ("현재 탭이 비활성화되었습니다", lang/ko.ts
 * activeTabChange; its OK reloads) — and goes back as soon as a newer save arrives. No reload button
 * here (review round 3: a button mid-wait reads as "done" and a reload mid-save throws the save away),
 * and no ✅/⚠/❌: those mark the outcome.
 */
/*
 * Account mode: the same alert also appears when another DEVICE takes the account session, and a server that keeps refusing
 * the saves (hubRejecting from the core) is named outright — waiting cannot help then.
 */
function rpfWaitingDisplay({ setStatus, isAborted, account = false }) {
  let shownText = '';
  return ({ waitedMs, sinceSaveMs, hubRejecting = false }) => {
    if (isAborted() || waitedMs < RPF_SLOW_SAVE_NOTICE_MS) return;
    const waited = Math.floor(waitedMs / 1000);
    const who = account ? '다른 탭이나 다른 기기가' : '다른 탭이';
    const stalled = `리스가 "현재 탭이 비활성화되었습니다" 안내를 띄웠다면 ${who} 저장을 가져가서 이 탭은 저장을 멈춘 상태예요. 그 안내의 OK를 누르면 새로고침되니, `
      + '그다음 이 도구를 다시 실행해 주세요 (아직 저장되지 않았다면 고장으로 나오니 한 번 더 고치면 돼요).';
    let text = sinceSaveMs >= RPF_SAVE_STALL_HINT_MS
      ? `⏳ 리스 저장을 기다리는 중이에요 (${waited}초) — 큰 저장 파일은 한 번 저장하는 데 몇 분 걸리기도 해서, 그대로 두는 게 좋아요.\n${stalled}`
      : `⏳ 리스 저장을 기다리는 중이에요 (${waited}초). 데이터베이스가 크거나 기기가 느리면 몇 분 걸리기도 해요 — `
        + '그대로 두면 저장이 끝나는 대로 완료 표시가 떠요.\n그만 기다리려면 닫기(×)를 누르세요 (바꾼 표시는 그대로예요).';
    if (account && hubRejecting) {
      text = `⏳ 리스 저장을 기다리는 중이에요 (${waited}초) — 리스가 저장을 보냈는데 계정 서버의 저장 파일이 바뀌지 않고 있어요.\n`
        + `계정 서버가 저장을 받지 않는 상태예요 (${who} 계정 세션을 가져갔거나 서버 쪽 문제). ${stalled}`;
    }
    if (text !== shownText) {
      shownText = text;
      setStatus(text);
    }
  };
}

function openFixPanel() {
  // A panel owns its in-flight run; replacing it must cancel that run, not just detach the element.
  const previous = document.getElementById(RPF_PANEL_ID);
  if (previous) {
    if (typeof previous.rpfDispose === 'function') previous.rpfDispose();
    else previous.remove();
  }
  const host = document.createElement('div');
  host.id = RPF_PANEL_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${RPF_STYLE}</style>
    <div class="panel" role="dialog" aria-label="컵케익 리스 플러그인 저장소 고치기">
      <div class="head">
        <h2>🧁 플러그인 저장소 고치기 <span class="version">v${RPF_VERSION}</span></h2>
        <button class="close" type="button" aria-label="닫기">✕</button>
      </div>
      <p class="tabs">⚠ 다른 리스 탭은 모두 닫고, 이 탭을 새로고침한 직후에 실행해 주세요. 다른 탭이 열려 있으면 그 탭이 고장 난 상태를 다시 저장할 수 있어요.</p>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="detail"></div>
      <div class="alert device-gate" hidden>
        <p class="warn">계정 모드: 고치기 전에 확인해 주세요</p>
        <p class="device-why"></p>
        <label class="check"><input class="devices-closed" type="checkbox"> <span class="device-text"></span></label>
      </div>
      <div class="confirm" hidden>
        <p class="warn">초기화하기 전에 확인해 주세요</p>
        <ul class="confirm-list"></ul>
        <label class="check"><input class="agree" type="checkbox"> <span>알겠어요. 플러그인 저장소를 새로 시작할게요.</span></label>
        <div class="actions">
          <button class="do-reset danger" type="button" disabled>초기화하기</button>
          <button class="cancel-reset" type="button">취소</button>
        </div>
      </div>
      <div class="actions main-actions" hidden>
        <button class="recover primary" type="button" hidden>고른 시점으로 되살리기</button>
        <button class="reset" type="button" hidden>초기화하기…</button>
        <button class="reload primary" type="button" hidden>지금 새로고침</button>
        <button class="rerun" type="button" hidden>다시 확인</button>
      </div>
      <p class="note net-note">이 도구가 직접 바꾸는 건 리스 데이터베이스 안의 플러그인 저장소 목차 표시 하나뿐이에요. 아무것도 인터넷으로 보내지 않아요.</p>
    </div>`;
  document.body.appendChild(host);
  root.querySelector('.device-why').textContent = RPF_DEVICE_GATE_WHY;
  root.querySelector('.device-text').textContent = RPF_DEVICE_GATE_TEXT;

  const status = root.querySelector('.status');
  const detail = root.querySelector('.detail');
  const confirmBox = root.querySelector('.confirm');
  const confirmList = root.querySelector('.confirm-list');
  const agree = root.querySelector('.agree');
  const doReset = root.querySelector('.do-reset');
  const mainActions = root.querySelector('.main-actions');
  const recoverButton = root.querySelector('.recover');
  const resetButton = root.querySelector('.reset');
  const reloadButton = root.querySelector('.reload');
  const rerunButton = root.querySelector('.rerun');
  const tabsNote = root.querySelector('.tabs');
  const netNote = root.querySelector('.net-note');
  const deviceGate = root.querySelector('.device-gate');
  const devicesClosed = root.querySelector('.devices-closed');
  const env = RisuPluginStorageFix.createBrowserEnv(window);
  // AbortController of the in-flight diagnose / repair, if any.
  let running = null;
  let disposed = false;
  let diagnosis = null;

  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.className = `status ${tone}`;
  };
  const isAccount = () => Boolean(diagnosis && diagnosis.backend === 'account');
  /* In account mode the edit buttons stay disabled until the other-devices box is ticked (the core refuses without it too). */
  const gateOpen = () => !isAccount() || devicesClosed.checked;
  const syncGate = () => {
    for (const button of [recoverButton, resetButton]) button.disabled = !gateOpen();
    doReset.disabled = !(agree.checked && gateOpen());
  };
  const showButtons = (visible) => {
    for (const button of [recoverButton, resetButton, reloadButton, rerunButton]) {
      button.hidden = !visible.includes(button);
      button.disabled = false;
    }
    mainActions.hidden = visible.length === 0;
    syncGate();
  };
  const closeConfirm = () => {
    confirmBox.hidden = true;
    agree.checked = false;
    doReset.disabled = true;
  };
  const buttonsByName = { reload: reloadButton, rerun: rerunButton };
  const setBackendNotes = (account) => {
    tabsNote.textContent = account
      ? '⚠ 다른 기기(휴대폰·다른 컴퓨터)와 다른 탭의 리스는 모두 닫고, 이 탭을 새로고침한 직후에 실행해 주세요. 열려 있는 다른 기기나 탭이 고장 난 상태를 다시 저장할 수 있어요.'
      : '⚠ 다른 리스 탭은 모두 닫고, 이 탭을 새로고침한 직후에 실행해 주세요. 다른 탭이 열려 있으면 그 탭이 고장 난 상태를 다시 저장할 수 있어요.';
    netNote.textContent = account
      ? '이 도구가 직접 바꾸는 건 리스 데이터베이스 안의 플러그인 저장소 목차 표시 하나뿐이에요. 계정 모드에서는 리스가 쓰는 계정 서버에, 이 기기의 로그인으로, 리스가 하는 것과 같은 읽기 요청만 보내요 (쓰기·삭제 요청은 보내지 않아요).'
      : '이 도구가 직접 바꾸는 건 리스 데이터베이스 안의 플러그인 저장소 목차 표시 하나뿐이에요. 아무것도 인터넷으로 보내지 않아요.';
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (running) running.abort();
    host.remove();
  };
  host.rpfDispose = dispose;

  const addAccountHint = () => {
    const box = document.createElement('div');
    box.className = 'alert';
    box.appendChild(rpfParagraph('먼저 확인해 주세요', 'warn'));
    box.appendChild(rpfParagraph(RPF_ACCOUNT_HINT));
    detail.appendChild(box);
  };

  const renderCandidates = (result) => {
    const { candidates } = result;
    const account = result.backend === 'account';
    if (result.accountHint) addAccountHint();
    if (candidates.length === 0) {
      detail.appendChild(rpfParagraph(account
        ? '계정 서버에서 살아 있는 예전 목차는 찾지 못했어요. 이 목차에 있던 값들은 이미 어느 기기에서도 읽을 수 없는 상태예요.'
          + ' 초기화하면 없는 목차를 가리키는 표시만 지우고, 플러그인 저장소가 모든 기기에서 새로 시작해요.'
        : '살아 있는 예전 목차는 찾지 못했어요. 이 목차에 있던 값들은 이 기기에서 이미 읽을 수 없는 상태예요.'
          + ' 초기화하면 없는 목차를 가리키는 표시만 지우고, 플러그인 저장소가 새로 시작해요.'));
    } else {
      detail.appendChild(rpfParagraph(`${account ? '계정 서버에서 ' : ''}살아 있는 예전 목차(플러그인 데이터를 저장해 둔 시점)를 ${candidates.length}개 찾았어요. `
        + '하나를 고르면 그 시점의 플러그인 데이터로 돌아가요 (맨 위가 가장 최근).'
        + (account ? ' 고른 시점은 이 계정을 쓰는 모든 기기에 반영돼요.' : '')));
      candidates.forEach((candidate, index) => {
        const row = document.createElement('label');
        row.className = 'candidate';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'candidate';
        radio.value = candidate.id;
        // With an account trace the newest local copy may be older than the account's data, so
        // nothing is preselected and the user has to pick deliberately.
        radio.checked = index === 0 && !result.accountHint;
        const text = document.createElement('div');
        const title = document.createElement('div');
        /* Account candidates carry flushedAt (from the index's own trash record, device clock) instead of a file time. */
        const when = account
          ? (typeof candidate.flushedAt === 'number' ? `${rpfFormatTime(candidate.flushedAt)} 무렵 저장` : '저장 시점 정보 없음')
          : rpfFormatTime(candidate.lastModified);
        title.textContent = `${when} · 값 ${candidate.keyCount}개`;
        text.appendChild(title);
        if (candidate.sampleKeys.length > 0) {
          const keys = document.createElement('div');
          keys.className = 'keys';
          const more = candidate.keyCount > candidate.sampleKeys.length ? ' …' : '';
          keys.textContent = `예: ${candidate.sampleKeys.join(', ')}${more}`;
          text.appendChild(keys);
        }
        if (candidate.missingLarge > 0) {
          const missing = document.createElement('div');
          missing.className = 'keys error';
          missing.textContent = `큰 값 ${candidate.largeCount}개 중 ${candidate.missingLarge}개는 ${account ? '계정 서버에 ' : ''}파일이 없어서 빈 값으로 읽혀요. `
            + '이 시점을 고르면 리스 백업 때 "불완전" 확인이 뜨거나 계정 동기화가 거절될 수 있어요 (플러그인이 그 값을 다시 저장하면 풀려요).';
          text.appendChild(missing);
        }
        row.appendChild(radio);
        row.appendChild(text);
        detail.appendChild(row);
      });
      detail.appendChild(rpfParagraph('되살린 뒤에는 리스가 정리 시점이 지난 예전 파일을 지울 수 있어서, 다른 시점으로 다시 바꾸기는 어려워요.', 'note'));
    }
    if (result.uncertainCount > 0) {
      detail.appendChild(rpfParagraph(`파일 ${result.uncertainCount}개는 확실하게 읽지 못해서 후보에서 뺐어요. `
        + '다른 리스 탭을 닫고 새로고침한 뒤 다시 확인하면 보일 수도 있어요.', 'note'));
    }
    deviceGate.hidden = !account;
    devicesClosed.checked = false;
  };

  const fillConfirm = () => {
    confirmList.textContent = '';
    const items = [];
    const count = diagnosis && diagnosis.candidates ? diagnosis.candidates.length : 0;
    if (count > 0) {
      items.push(`되살릴 수 있는 예전 목차가 ${count}개 있는데, 그걸 쓰지 않고 새로 시작해요. 초기화한 뒤에는 이 도구가 그 목차들을 다시 보여 주지 않아요.`);
    } else {
      items.push('지워지는 건 없어진 목차를 가리키는 표시 하나뿐이에요. 그 목차에 있던 값들은 이미 이 기기에서 읽을 수 없는 상태예요.');
    }
    items.push('리스 플러그인 저장소는 플러그인끼리 나눠 쓰는 한 칸이라, 한 플러그인 몫만 골라 지울 수는 없어요. '
      + '플러그인이 이 저장소에 넣어 두던 데이터(예: CPM 사용량 기록)는 새로 시작해요. '
      + '예전 리스 버전 방식으로 목차 밖에 따로 저장돼 있던 값이 있다면, 그 값은 그대로 다시 들어와요.');
    items.push('그대로 남는 것: 캐릭터·채팅·설정, 리스에 설치된 플러그인과 그 설정값, 플러그인의 로컬 저장소(safeLocalStorage·IndexedDB).');
    if (isAccount()) {
      items.push('계정 모드라서 초기화는 이 계정을 쓰는 모든 기기에 반영돼요. 다른 기기와 탭의 리스를 닫았는지 위에서 확인해 주세요.');
    } else {
      items.push(diagnosis && diagnosis.accountHint
        ? RPF_ACCOUNT_HINT
        : '최근에 Risu 계정 로그아웃이나 "계정에 저장" 끄기를 했다면, 목차가 계정 쪽에 남아 있을 수도 있어요 (이 도구로는 확인할 수 없어요). 그렇다면 그쪽부터 확인해 보세요.');
    }
    for (const text of items) {
      const item = document.createElement('li');
      item.textContent = text;
      confirmList.appendChild(item);
    }
  };

  const render = (result) => {
    diagnosis = result;
    closeConfirm();
    detail.textContent = '';
    deviceGate.hidden = true;
    devicesClosed.checked = false;
    setBackendNotes(isAccount());
    const accountView = isAccount() ? rpfAccountStatus(result) : null;
    if (accountView) {
      setStatus(accountView.text, accountView.tone);
      showButtons(accountView.buttons.map((name) => buttonsByName[name]));
      return;
    }
    if (result.state === 'not-risu') {
      setStatus('이 페이지에서 리스를 찾지 못했어요. 리스 탭에서, 화면이 다 뜬 뒤에 실행해 주세요.', 'error');
      showButtons([rerunButton]);
      return;
    }
    if (result.state === 'not-ready') {
      setStatus('리스가 아직 다 열리지 않았어요. 잠시 뒤 다시 확인해 주세요.', 'error');
      showButtons([rerunButton]);
      return;
    }
    if (result.state === 'unsupported-backend') {
      setStatus(RPF_BACKEND_TEXT[result.backend] || RPF_BACKEND_TEXT.tauri, 'error');
      showButtons([]);
      return;
    }
    if (result.state === 'unsupported-browser') {
      setStatus(RPF_BROWSER_TEXT[result.missing] || RPF_BROWSER_TEXT.opfs, 'error');
      showButtons([]);
      return;
    }
    if (result.state === 'no-index') {
      setStatus(isAccount()
        ? '✅ 플러그인 저장소는 정상이에요. 계정 서버의 저장 파일에도 목차 표시가 없어요 (아직 저장된 값이 없어요). 고칠 게 없어요.'
        : '✅ 플러그인 저장소는 정상이에요 (아직 저장된 값이 없어요). 고칠 게 없어요.', 'ok');
      showButtons([]);
      return;
    }
    if (result.state === 'healthy') {
      setStatus(`✅ 플러그인 저장소는 정상이에요 (값 ${result.keyCount}개). 고칠 게 없어요.\n`
        + '다른 오류가 보인다면 이 도구로 고치는 문제가 아니에요.', 'ok');
      showButtons([]);
      return;
    }
    if (result.state === 'uncertain') {
      setStatus('⚠ 플러그인 저장소 목차 파일이 있긴 한데, 이 도구가 확실하게 읽지 못했어요 (잠겨 있거나, 리스는 읽을 수 있는 형태일 수도 있어요).\n'
        + '안전을 위해 아무것도 바꾸지 않았어요. 다른 리스 탭을 닫고 새로고침한 뒤 다시 확인해 주세요.', 'error');
      if (result.accountHint) addAccountHint();
      showButtons([rerunButton]);
      return;
    }
    const why = isAccount()
      ? (result.reason === 'unreadable'
        ? '계정 서버의 플러그인 저장소 목차가 손상돼서 읽을 수 없어요.'
        : '계정 서버에 플러그인 저장소 목차가 없어요 (이 기기에도 사본이 없어요).')
      : (result.reason === 'unreadable'
        ? '플러그인 저장소 목차 파일이 손상돼서 읽을 수 없어요.'
        : '플러그인 저장소 목차 파일이 이 브라우저에 없어요.');
    setStatus(`❌ ${why}\n그래서 리스가 모든 플러그인의 저장소 요청을 거부하고 있어요 (Failed to load plugin storage index).`, 'error');
    renderCandidates(result);
    const buttons = [resetButton];
    if (result.candidates.length > 0) buttons.unshift(recoverButton);
    showButtons(buttons);
  };

  const runDiagnose = async () => {
    if (running) running.abort();
    const run = new AbortController();
    running = run;
    showButtons([]);
    closeConfirm();
    detail.textContent = '';
    setStatus('플러그인 저장소 상태 확인 중…');
    let lastProgressAt = 0;
    try {
      const result = await RisuPluginStorageFix.diagnose(env, {
        signal: run.signal,
        onProgress: (done, total) => {
          const now = Date.now();
          if (now - lastProgressAt < RPF_PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          setStatus(`살아 있는 예전 목차 찾는 중… (${done}/${total})`);
        },
      });
      if (run.signal.aborted) return;
      render(result);
    } catch (error) {
      if (run.signal.aborted) return;
      setStatus(`❌ ${rpfErrorText(error)}`, 'error');
      showButtons([rerunButton]);
    } finally {
      if (running === run) running = null;
    }
  };

  const runRepair = async (action) => {
    if (!diagnosis || diagnosis.state !== 'broken') return;
    let candidateId = null;
    if (action === 'recover') {
      const picked = root.querySelector('input[name="candidate"]:checked');
      if (!picked) {
        setStatus('되살릴 시점을 하나 골라 주세요.', 'error');
        return;
      }
      candidateId = picked.value;
    }
    const account = isAccount();
    if (account && !devicesClosed.checked) {
      setStatus('먼저 "다른 기기와 다른 탭의 리스를 모두 닫았어요"에 체크해 주세요.', 'error');
      return;
    }
    const run = new AbortController();
    running = run;
    showButtons([]);
    closeConfirm();
    deviceGate.hidden = true;
    /* Account repair first re-checks every item on the account server (core refuses an edit after an incomplete scan), which
       takes as long as the scan in the diagnosis did — so it shows the same n/N count instead of promising seconds. */
    setStatus(account
      ? '바꾸기 전에 계정 서버를 한 번 더 확인하고, 리스가 계정 서버에 저장을 마칠 때까지 기다려요. 창을 닫지 마세요.'
      : '바꾸는 중… 리스가 저장을 마칠 때까지 기다려요 (보통 몇 초). 창을 닫지 마세요.');
    const onWaiting = rpfWaitingDisplay({ setStatus, isAborted: () => run.signal.aborted, account });
    const onProgress = account ? (done, total) => {
      if (run.signal.aborted) return;
      setStatus(done < total
        ? `바꾸기 전에 계정 서버의 항목을 한 번 더 확인하는 중… (${done}/${total}) 창을 닫지 마세요.`
        : '바꾸는 중… 리스가 계정 서버에 저장을 마칠 때까지 기다려요. 창을 닫지 마세요.');
    } : undefined;
    const devices = { devicesClosed: account ? devicesClosed.checked : undefined };
    try {
      if (action === 'recover') {
        await RisuPluginStorageFix.recover(env, { pointer: diagnosis.pointer, candidateId, signal: run.signal, onWaiting, onProgress, ...devices });
      } else {
        await RisuPluginStorageFix.reset(env, { pointer: diagnosis.pointer, signal: run.signal, onWaiting, onProgress, ...devices });
      }
      if (run.signal.aborted) return;
      detail.textContent = '';
      const reloadHint = '\n이 도구가 바꾼 표시는 저장까지 끝났어요. 방금 플러그인을 쓰던 중이었다면 몇 초 뒤에 새로고침해 주세요 '
        + '(플러그인이 따로 저장 중인 값까지는 이 도구가 확인할 수 없어요).'
        + '\n브라우저가 "사이트에서 나가시겠습니까?"라고 물으면 새로고침(나가기)을 눌러 주세요.'
        + (account ? '\n다른 기기에서는 리스를 새로 열어 주세요 (열어 둔 창이 있으면 새로고침). 고치기 전에 열려 있던 기기가 그대로 저장하면 다시 고장 날 수 있어요 — 그러면 이 도구를 다시 실행해 주세요.' : '');
      const where = account ? '계정 서버의 저장 파일' : '리스 저장 파일';
      setStatus((action === 'recover'
        ? `✅ 고른 시점의 목차로 되돌리고, ${where}에 반영된 것까지 확인했어요.\n"지금 새로고침"을 누르면 플러그인들이 되살린 데이터로 다시 시작해요.`
        : `✅ 없는 목차 표시를 지우고, ${where}에 반영된 것까지 확인했어요.\n"지금 새로고침"을 누르면 플러그인 저장소가 새로 시작해요.`) + reloadHint, 'ok');
      showButtons([reloadButton]);
    } catch (error) {
      if (run.signal.aborted) return;
      const view = rpfRepairErrorView(error, error instanceof RisuPluginStorageFix.FixError, rpfErrorText(error));
      setStatus(view.text, view.tone);
      showButtons(view.buttons.map((name) => buttonsByName[name]));
    } finally {
      if (running === run) running = null;
    }
  };

  root.querySelector('.close').addEventListener('click', dispose);
  rerunButton.addEventListener('click', runDiagnose);
  recoverButton.addEventListener('click', () => runRepair('recover'));
  resetButton.addEventListener('click', () => {
    fillConfirm();
    confirmBox.hidden = false;
    agree.checked = false;
    syncGate();
  });
  agree.addEventListener('change', syncGate);
  devicesClosed.addEventListener('change', syncGate);
  root.querySelector('.cancel-reset').addEventListener('click', closeConfirm);
  doReset.addEventListener('click', () => {
    if (agree.checked && gateOpen()) runRepair('reset');
  });
  reloadButton.addEventListener('click', () => location.reload());

  runDiagnose();
}


openFixPanel();
})();
