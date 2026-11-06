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

  return { SAVE_POLL_INTERVAL_MS, PREFIX_READ_LIMIT, SAMPLE_KEY_COUNT,
    FixError, createBrowserEnv, backend, diagnose, findCandidates, recover, reset,
    readPersistedPointer, waitForPersisted };
})();

if (typeof module !== 'undefined') module.exports = RisuPluginStorageFix; // @strip-in-bundle
