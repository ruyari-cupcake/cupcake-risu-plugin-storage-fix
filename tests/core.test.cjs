// Fixtures use node:zlib and an independent save-file reader, not the core's parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gzipSync, gunzipSync, inflateRawSync } = require('node:zlib');
const corePath = path.join(__dirname, '../src/core.js');
const core = fs.existsSync(corePath) ? require(corePath) : {};
const TYPE = 'risu-plugin-storage-index';
const DB = 'database/database.bin';
const BACKUP = 'database/dbbackup-';
const hex = (text) => Buffer.from(text).toString('hex');
const coldName = (id) => `coldstorage_${id}.json`;
const index = (entries = [], trash = []) => ({ type: TYPE, version: 1, entries, trash });

function api(name) {
  assert.equal(typeof core[name], 'function', `contract API ${name} must exist`);
  return core[name];
}

function block(type, name, value, compressed = false) {
  const nameBytes = Buffer.from(name);
  const plain = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const data = compressed ? gzipSync(plain) : plain;
  const header = Buffer.alloc(7 + nameBytes.length);
  header.set([type, Number(compressed), nameBytes.length]);
  nameBytes.copy(header, 3);
  header.writeUInt32LE(data.length, 3 + nameBytes.length);
  return Buffer.concat([header, data]);
}

function save(storage, compressed = false) {
  return Buffer.concat([
    Buffer.from('RISUSAVE\0'),
    block(0, 'root', { characters: ['keep-me'], pluginCustomStorage: { _coldpluginIndex: 'decoy' } }),
    block(3, 'chat', Buffer.alloc(10000, 97)),
    block(11, 'pluginStorage', storage, compressed),
    block(6, 'plugins', [{ name: 'unchanged' }]),
  ]);
}

function stockSaveView(bytes) {
  const blocks = [];
  let offset = 9;
  while (offset < bytes.length) {
    const type = bytes[offset++];
    const compressed = bytes[offset++];
    const nameLength = bytes[offset++];
    const name = bytes.subarray(offset, offset + nameLength).toString();
    offset += nameLength;
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    const raw = bytes.subarray(offset, offset + length);
    offset += length;
    blocks.push({ type, name, raw: Buffer.from(raw), data: compressed === 1 ? gunzipSync(raw) : raw });
  }
  return { blocks, storage: JSON.parse(blocks.find((item) => item.type === 11).data.toString()) };
}

async function confirms(promise) {
  let result;
  await assert.doesNotReject(async () => { result = await promise; }, 'a valid post-edit save must produce a receipt');
  return result;
}

function fixture({ storage = { _coldpluginIndex: 'dead' }, location = 'idb', flags = {} } = {}) {
  const local = new Map(Object.entries(flags));
  if (location === 'opfs') local.set('opfs_flag!', 'able');
  const files = new Map();
  const forage = new Map();
  const calls = { root: 0, keys: 0, get: [], files: [], slices: [], writes: [], sleeps: 0, cancelled: 0 };
  let onWrite = () => {};
  const live = new Proxy(storage, {
    set(target, key, value) { calls.writes.push(['set', key, value]); target[key] = value; onWrite(); return true; },
    deleteProperty(target, key) { calls.writes.push(['delete', key]); const result = delete target[key]; onWrite(); return result; },
  });
  let clock = 100;
  let onSleep = async () => {};
  let onFile = async () => {};
  const fileHandle = (name) => ({
    kind: 'file',
    async getFile() {
      calls.files.push(name);
      await onFile(name);
      if (!files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      const item = files.get(name);
      if (item.error) throw item.error;
      const blob = new Blob([item.bytes]);
      return {
        size: blob.size,
        lastModified: item.time,
        stream: () => blob.stream(),
        slice(start, end) { calls.slices.push([name, start, end]); return blob.slice(start, end); },
        arrayBuffer() { throw new Error('whole-file arrayBuffer is forbidden'); },
      };
    },
  });
  const root = {
    async *entries() { for (const name of files.keys()) yield [name, fileHandle(name)]; },
    async getFileHandle(name, options) {
      assert.notEqual(options?.create, true, 'never create a file');
      if (!files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return fileHandle(name);
    },
    removeEntry() { assert.fail('never delete a file'); },
  };
  const env = {
    pluginApis: () => ({ getDatabase: () => ({ pluginCustomStorage: live }) }),
    localStorage: { getItem: (key) => local.get(key) ?? null, setItem() { assert.fail('localStorage write'); } },
    isNode: false,
    isTauri: false,
    hasOpfs: true,
    hasDecompression: true,
    opfsWritable: true,
    opfsRoot: async () => { calls.root += 1; return root; },
    forage: {
      keys: async () => { calls.keys += 1; return [...forage.keys()]; },
      getItem: async (key) => { calls.get.push(key); return forage.get(key) ?? null; },
      setItem() { assert.fail('IndexedDB write'); },
    },
    gunzip(input) {
      const stream = typeof input.stream === 'function' ? input.stream() : new Blob([input]).stream();
      const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
      return new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (error) { controller.error(error); }
        },
        cancel() { calls.cancelled += 1; return reader.cancel(); },
      });
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; calls.sleeps += 1; await onSleep(); },
  };
  function putDatabase(bytes) {
    if (location === 'opfs') files.set(hex(DB), { bytes: Buffer.from(bytes), time: clock });
    else forage.set(DB, new Uint8Array(bytes));
  }
  function persist({ compressed = true, number = clock, from = live } = {}) {
    const bytes = save(from, compressed);
    putDatabase(bytes);
    const key = `${BACKUP}${number}.bin`;
    if (location === 'opfs') files.set(hex(key), { bytes, time: clock });
    else forage.set(key, new Uint8Array(bytes));
  }
  function add(id, value, time = 1) { files.set(coldName(id), { bytes: gzipSync(JSON.stringify(value)), time }); }
  function persisted() {
    return Buffer.from(location === 'opfs' ? files.get(hex(DB)).bytes : forage.get(DB));
  }
  return { env, live, files, forage, local, calls, add, putDatabase, persist, persisted,
    onSleep(fn) { onSleep = fn; }, onFile(fn) { onFile = fn; }, onWrite(fn) { onWrite = fn; } };
}

function untouched(f) {
  return { files: [...f.files].map(([name, item]) => [name, Buffer.from(item.bytes)]),
    forage: [...f.forage].map(([name, value]) => [name, value instanceof Uint8Array ? Buffer.from(value) : value]),
    local: [...f.local] };
}

// Independent model of stock doLoad: a repaired pointer must reopen the exact recovered index.
function reopen(f, storage) {
  const pointer = storage._coldpluginIndex;
  if (typeof pointer !== 'string') return index();
  const item = f.files.get(coldName(pointer));
  if (!item) throw new Error('Failed to load plugin storage index');
  const value = JSON.parse(gunzipSync(item.bytes).toString());
  if (!value || value.type !== TYPE || !Array.isArray(value.entries) || !Array.isArray(value.trash)) {
    throw new Error('Failed to load plugin storage index');
  }
  return value;
}

test('diagnose distinguishes not-risu, not-ready, no-index, healthy, missing and unreadable without mutation', async () => {
  const diagnose = api('diagnose');
  const f = fixture();
  f.env.pluginApis = () => undefined;
  assert.deepEqual(await diagnose(f.env), { state: 'not-risu' });
  f.env.pluginApis = () => ({});
  assert.deepEqual(await diagnose(f.env), { state: 'not-risu' });
  for (const storage of [undefined, null, 'not-ready']) {
    f.env.pluginApis = () => ({ getDatabase: () => ({ pluginCustomStorage: storage }) });
    assert.deepEqual(await diagnose(f.env), { state: 'not-ready' });
  }
  for (const pointer of [undefined, null, 7]) {
    const empty = fixture({ storage: { _coldpluginIndex: pointer } });
    assert.deepEqual(await diagnose(empty.env), { state: 'no-index', backend: 'web' });
    assert.equal(empty.calls.root, 0);
  }
  const before = untouched(f);
  const broken = fixture();
  assert.deepEqual(await diagnose(broken.env), {
    state: 'broken', backend: 'web', pointer: 'dead', reason: 'missing', candidates: [], uncertainCount: 0, accountHint: false,
  });
  for (const bad of [gzipSync('not JSON'), gzipSync(JSON.stringify({ type: TYPE, entries: [] }))]) {
    broken.files.set(coldName('dead'), { bytes: bad, time: 5 });
    const result = await diagnose(broken.env);
    assert.equal(result.reason, 'unreadable');
    assert.equal(result.state, 'broken');
  }
  broken.add('dead', index([{ k: 'a', s: '1' }, { k: 'b', s: 'false' }]));
  assert.deepEqual(await diagnose(broken.env), { state: 'healthy', backend: 'web', pointer: 'dead', keyCount: 2 });
  assert.deepEqual(untouched(f), before);
  assert.deepEqual(broken.calls.writes, []);
});

test('all entry points refuse account/node/Tauri before OPFS or IndexedDB access', async () => {
  api('diagnose');
  for (const backend of ['account', 'node', 'tauri']) {
    const f = fixture({ flags: backend === 'account' ? { accountst: 'able' } : {} });
    f.env.isNode = backend === 'node';
    f.env.isTauri = backend === 'tauri';
    f.env.opfsRoot = () => assert.fail('unsupported OPFS access');
    f.env.forage = new Proxy({}, { get() { assert.fail('unsupported forage access'); } });
    assert.deepEqual(await core.diagnose(f.env), { state: 'unsupported-backend', backend });
    for (const operation of [
      () => core.findCandidates(f.env), () => core.readPersistedPointer(f.env),
      () => core.waitForPersisted(f.env, () => true),
      () => core.recover(f.env, { pointer: 'dead', candidateId: 'good' }),
      () => core.reset(f.env, { pointer: 'dead' }),
    ]) await assert.rejects(operation, { code: 'UNSUPPORTED_BACKEND' });
    assert.deepEqual(f.calls.writes, []);
  }
});

test('candidate scan checks the prefix, full shape, ordering, samples, exclusion and missing large files', async () => {
  const findCandidates = api('findCandidates');
  const f = fixture();
  const entries = Array.from({ length: 10 }, (_, i) => ({ k: `key-${i}`, s: 'null' }));
  entries.push({ k: 'large', l: 'exists' }, { k: 'lost', l: 'gone' });
  // Stock doLoad skips entries without a string key, so they are neither counted nor sampled.
  f.add('old', index([{ s: '1' }, { k: 7, s: '2' }, { k: 'old', s: '1' }]), 10);
  f.add('new', index(entries, [{ id: 'expired', at: 0, index: true }]), 30);
  f.add('dead', index([{ k: 'excluded' }]), 100);
  f.add('exists', { payload: 'large data' }, 40);
  f.add('chat', { message: [{ data: 'x'.repeat(200000) + TYPE }] }, 1000);
  f.add('bad-shape', { type: TYPE, entries: [], trash: {} }, 90);
  f.add('wrong-type', { type: 'other', entries: [], trash: [] }, 100);
  f.files.set(coldName('corrupt'), { bytes: Buffer.from('bad gzip'), time: 200 });
  f.files.set('unrelated.json', { bytes: gzipSync(JSON.stringify(index())), time: 200 });
  const before = untouched(f);
  const progress = [];
  const result = await findCandidates(f.env, { excludeId: 'dead', onProgress: (...args) => progress.push(args) });
  assert.deepEqual(result, [
    { id: 'new', lastModified: 30, keyCount: 12, sampleKeys: entries.slice(0, 8).map((e) => e.k), largeCount: 2, missingLarge: 1 },
    { id: 'old', lastModified: 10, keyCount: 1, sampleKeys: ['old'], largeCount: 0, missingLarge: 0 },
  ]);
  assert.ok(f.calls.cancelled >= 1, 'non-index stream must stop at prefix, not read whole chat');
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  assert.ok(progress.at(-1)[1] >= 8);
  assert.ok(progress.every(([done, total], i) => done <= total && (!i || done >= progress[i - 1][0])));
  assert.deepEqual(untouched(f), before);
});

test('candidate prefix spans chunks and rejects a type string appearing only later without draining the stream', async () => {
  const findCandidates = api('findCandidates');
  const f = fixture();
  f.add('one-byte-chunks', index([{ k: '한글', s: 'true' }]));
  f.add('chat', { message: TYPE });
  let pulls = 0;
  let chatPulls = 0;
  let cancels = 0;
  f.env.gunzip = (input) => {
    let offset = 0;
    let plain;
    return new ReadableStream({
      async pull(controller) {
        if (!plain) plain = gunzipSync(Buffer.from(await new Response(input.stream()).arrayBuffer()));
        pulls += 1;
        if (plain[2] === 109) chatPulls += 1;
        if (plain[0] === 123 && plain[2] === 109 && offset > 64) throw new Error('chat drained past prefix');
        if (offset === plain.length) controller.close();
        else controller.enqueue(new Uint8Array(plain.subarray(offset, ++offset)));
      },
      cancel() { cancels += 1; },
    }, { highWaterMark: 0 });
  };
  const result = await findCandidates(f.env);
  assert.deepEqual(result.map((candidate) => candidate.sampleKeys), [['한글']]);
  assert.ok(cancels > 0);
  assert.equal(chatPulls, 3, 'stop as soon as {"m mismatches the required {"t prefix');
  assert.ok(pulls < 220);
});

test('recover sets only the live pointer, confirms a new save and reopens exact recovered contents', async () => {
  const recover = api('recover');
  for (const location of ['idb', 'opfs']) {
    const legacy = { nested: ['unchanged'] };
    const map = { legacy: 'cold-id' };
    const f = fixture({ location, storage: { _coldpluginIndex: 'dead', inline: legacy, _coldplugin: map } });
    const wanted = index([{ k: 'a', s: '{"real":1}' }, { k: 'b', l: 'payload' }], [{ id: 'expired', at: 0 }]);
    f.add('good', wanted, 3);
    f.add('payload', { real: ['large value'] });
    f.persist({ from: { ...f.live }, number: 10 });
    const coldBefore = [...f.files].filter(([name]) => name.startsWith('coldstorage_'));
    const baseline = stockSaveView(f.persisted());
    let sleeps = 0;
    f.onSleep(() => {
      sleeps += 1;
      if (sleeps === 1) f.persist({ from: { ...f.live, _coldpluginIndex: 'dead' }, number: 11 });
      if (sleeps === 2) f.persist({ number: 12 });
    });
    assert.throws(() => reopen(f, { _coldpluginIndex: 'dead' }), /Failed to load/);
    assert.deepEqual(await recover(f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 5000 }), { confirmed: true, persistedPointer: 'good' });
    assert.equal(sleeps, 4, 'the stale in-flight save cannot confirm, and the live edit must settle');
    assert.deepEqual(f.calls.writes, [['set', '_coldpluginIndex', 'good']]);
    assert.strictEqual(f.live.inline, legacy);
    assert.strictEqual(f.live._coldplugin, map);
    assert.deepEqual([...f.files].filter(([name]) => name.startsWith('coldstorage_')), coldBefore);
    const after = stockSaveView(f.persisted());
    assert.deepEqual(after.storage, { _coldpluginIndex: 'good', inline: legacy, _coldplugin: map });
    assert.deepEqual(reopen(f, after.storage), wanted);
    assert.deepEqual(after.blocks.filter((b) => b.type !== 11), baseline.blocks.filter((b) => b.type !== 11));
    assert.deepEqual([...f.local], location === 'opfs' ? [['opfs_flag!', 'able']] : []);
  }
});

test('reset deletes rather than nulls only the pointer, preserves references and reopens an empty index', async () => {
  const reset = api('reset');
  const legacy = { deep: ['value'] };
  const map = { old: 'id' };
  const f = fixture({ storage: { _coldpluginIndex: 'dead', legacy, _coldplugin: map, safeLocalStorage: 'keep' } });
  f.add('unrelated', index([{ k: 'keep' }]));
  f.persist({ number: 1 });
  const original = untouched(f);
  const before = stockSaveView(f.persisted());
  f.onSleep(() => f.persist({ number: 2 }));
  assert.deepEqual(await reset(f.env, { pointer: 'dead', timeoutMs: 3000 }), { confirmed: true, persistedPointer: null });
  assert.equal(Object.hasOwn(f.live, '_coldpluginIndex'), false);
  assert.strictEqual(f.live.legacy, legacy);
  assert.strictEqual(f.live._coldplugin, map);
  assert.deepEqual(f.calls.writes, [['delete', '_coldpluginIndex']]);
  assert.deepEqual([...f.files].map(([name, item]) => [name, Buffer.from(item.bytes)]), original.files);
  assert.deepEqual([...f.local], original.local);
  const after = stockSaveView(f.persisted());
  assert.deepEqual(after.storage, { legacy, _coldplugin: map, safeLocalStorage: 'keep' });
  assert.deepEqual(reopen(f, after.storage), index());
  assert.deepEqual(after.blocks.filter((b) => b.type !== 11), before.blocks.filter((b) => b.type !== 11));
  assert.ok(Buffer.from(f.forage.get(`${BACKUP}1.bin`)).equals(original.forage.find(([name]) => name === `${BACKUP}1.bin`)[1]));
});

test('recover/reset refuse stale diagnosis, healthy or absent pointers, and invalid candidates without changing anything', async () => {
  api('recover');
  for (const method of ['recover', 'reset']) {
    for (const state of ['changed', 'healthy', 'absent']) {
      const f = fixture({ storage: state === 'absent' ? {} : { _coldpluginIndex: state === 'changed' ? 'other' : 'dead' } });
      if (state === 'healthy') f.add('dead', index());
      f.add('good', index());
      const before = untouched(f);
      await assert.rejects(core[method](f.env, { pointer: state === 'absent' ? undefined : 'dead', candidateId: 'good' }),
        { code: state === 'changed' ? 'CHANGED' : 'NOT_BROKEN' });
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(untouched(f), before);
    }
  }
  for (const bad of [null, { type: TYPE, entries: [], trash: null }, { type: 'other', entries: [], trash: [] }]) {
    const f = fixture();
    if (bad) f.add('good', bad);
    await assert.rejects(core.recover(f.env, { pointer: 'dead', candidateId: 'good' }), { code: 'CANDIDATE_INVALID' });
    assert.equal(f.live._coldpluginIndex, 'dead');
    assert.deepEqual(f.calls.writes, []);
  }
});

test('pointer/backend/cancellation races during validation are checked again before any mutation', async () => {
  api('recover');
  for (const race of ['pointer', 'backend', 'abort', 'healed']) {
    const f = fixture();
    f.add('good', index());
    const controller = new AbortController();
    f.onFile((name) => {
      if (name !== coldName('good')) return;
      if (race === 'pointer') f.live._coldpluginIndex = 'other';
      if (race === 'backend') f.env.isNode = true;
      if (race === 'abort') controller.abort();
      if (race === 'healed') f.add('dead', index());
    });
    await assert.rejects(core.recover(f.env, { pointer: 'dead', candidateId: 'good', signal: controller.signal }),
      { code: { pointer: 'CHANGED', backend: 'UNSUPPORTED_BACKEND', abort: 'CANCELLED', healed: 'NOT_BROKEN' }[race] });
    assert.ok(!f.calls.writes.some((write) => write[2] === 'good'));
  }
});

test('mutation entry points report NOT_RISU and NOT_READY with Korean FixErrors', async () => {
  api('FixError');
  for (const method of ['recover', 'reset']) {
    const f = fixture();
    f.env.pluginApis = () => undefined;
    await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'x' }), (error) =>
      error instanceof core.FixError && error.code === 'NOT_RISU' && /[가-힣]/.test(error.message));
    f.env.pluginApis = () => ({ getDatabase: () => ({}) });
    await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'x' }), { code: 'NOT_READY' });
  }
});

test('persisted pointer parses IDB and lazy OPFS, compressed and plain, ignoring decoy blocks', async () => {
  const read = api('readPersistedPointer');
  for (const location of ['idb', 'opfs']) {
    for (const compressed of [true, false]) {
      const f = fixture({ location });
      const bytes = save({ _coldpluginIndex: 'winner', other: 'keep' }, compressed);
      f.putDatabase(bytes);
      assert.deepEqual(await read(f.env), { format: 'risusave', hasBlock: true, pointer: 'winner' });
      assert.ok(f.persisted().equals(bytes));
      if (location === 'opfs') {
        const chat = stockSaveView(bytes).blocks.find((b) => b.name === 'chat');
        assert.ok(f.calls.slices.every(([, start, end]) => end - start < chat.raw.length), 'never read whole skipped blocks');
      }
    }
  }
  for (const storage of [{}, { _coldpluginIndex: null }, { _coldpluginIndex: 4 }]) {
    const f = fixture();
    f.putDatabase(save(storage));
    assert.deepEqual(await read(f.env), { format: 'risusave', hasBlock: true, pointer: null });
  }
  const f = fixture();
  f.putDatabase(Buffer.concat([Buffer.from('RISUSAVE\0'), block(0, 'root', {})]));
  assert.deepEqual(await read(f.env), { format: 'risusave', hasBlock: false, pointer: null });
});

test('location selection respects OPFS flag, migrated and existing IndexedDB data', async () => {
  const read = api('readPersistedPointer');
  for (const scenario of [
    { flag: false, migrated: true, existing: true, expected: 'idb' },
    { flag: true, migrated: false, existing: true, expected: 'idb' },
    { flag: true, migrated: true, existing: true, expected: 'opfs' },
    { flag: true, migrated: false, existing: false, expected: 'opfs' },
  ]) {
    const f = fixture({ flags: scenario.flag ? { 'opfs_flag!': 'able' } : {} });
    f.files.set(hex(DB), { bytes: save({ _coldpluginIndex: 'opfs' }), time: 1 });
    if (scenario.existing) f.forage.set(DB, new Uint8Array(save({ _coldpluginIndex: 'idb' })));
    f.forage.set('migrated', scenario.migrated);
    assert.equal((await read(f.env)).pointer, scenario.expected);
  }
});

test('missing/foreign/damaged save files never falsely confirm an absent pointer', async () => {
  const read = api('readPersistedPointer');
  const f = fixture({ storage: {} });
  f.onSleep(() => f.forage.set(`${BACKUP}${f.calls.sleeps}.bin`, new Uint8Array()));
  assert.deepEqual(await read(f.env), { format: 'unknown' });
  for (const bytes of [Buffer.from('other'), Buffer.from('RISUSAVE\0\x0b'),
    Buffer.concat([Buffer.from('RISUSAVE\0'), block(11, 'pluginStorage', Buffer.from('{broken'))]),
    save({ _coldpluginIndex: 'old' }).subarray(0, 100),
  ]) {
    f.putDatabase(bytes);
    assert.deepEqual(await read(f.env), { format: 'unknown' });
    await assert.rejects(core.waitForPersisted(f.env, (pointer) => pointer === null, { timeoutMs: 3000 }), { code: 'SAVE_UNCONFIRMED' });
  }
  // A well-formed save without the plugin storage block also reads as "no pointer"; it says
  // nothing about the pointer, so it must not confirm a reset either.
  f.putDatabase(Buffer.concat([Buffer.from('RISUSAVE\0'), block(0, 'root', {})]));
  assert.deepEqual(await read(f.env), { format: 'risusave', hasBlock: false, pointer: null });
  await assert.rejects(core.waitForPersisted(f.env, (pointer) => pointer === null, { timeoutMs: 3000 }), { code: 'SAVE_UNCONFIRMED' });
});

test('wait gate reads only after a strictly newer numeric backup, never trusting the live object', async () => {
  const wait = api('waitForPersisted');
  for (const location of ['idb', 'opfs']) {
    const f = fixture({ location, storage: { _coldpluginIndex: 'new' } });
    f.persist({ from: { _coldpluginIndex: 'old' }, number: 100 });
    let ticks = 0;
    f.onSleep(() => {
      ticks += 1;
      if (ticks === 1) f.putDatabase(save({ _coldpluginIndex: 'new' }));
      if (ticks === 2) {
        const key = `${BACKUP}99.bin`;
        if (location === 'idb') f.forage.set(key, new Uint8Array());
        else f.files.set(hex(key), { bytes: Buffer.alloc(0), time: 1 });
      }
      if (ticks === 3) f.persist({ number: 101 });
    });
    assert.deepEqual(await wait(f.env, (pointer) => pointer === 'new', { timeoutMs: 5000 }), { confirmed: true, persistedPointer: 'new' });
    assert.equal(ticks, 4, 'unannounced DB writes and older backups cannot open the gate, then the live edit must settle');
    const reads = location === 'idb' ? f.calls.get.filter((key) => key === DB).length : f.calls.files.filter((key) => key === hex(DB)).length;
    assert.equal(reads, location === 'idb' ? 1 : 2, 'IDB retains its receipt; OPFS still re-reads each gated poll');
  }
});

test('round2 matching disk and live state never confirm without a post-baseline backup, even long after the settle', async (t) => {
  // Round-2 review (Astra#3): the settle must never stand in for the backup gate. Disk already
  // matches live and nothing new is saved, so no read may happen and the wait must time out.
  for (const location of ['idb', 'opfs']) await t.test(location, async () => {
    const f = fixture({ location, storage: { _coldpluginIndex: 'good' } });
    f.persist({ number: 100, from: { _coldpluginIndex: 'good' } });
    const reads = () => (location === 'idb' ? f.calls.get.filter((key) => key === DB).length : f.calls.files.filter((key) => key === hex(DB)).length);
    const before = reads();
    const started = f.env.now();
    await assert.rejects(core.waitForPersisted(f.env, (pointer) => pointer === 'good', { timeoutMs: 6000 }), { code: 'SAVE_UNCONFIRMED' });
    assert.ok(f.env.now() - started >= 6000, 'the wait ran well past the settle window');
    assert.equal(reads(), before, 'no database read without a strictly newer backup');
  });
});

test('wait timeouts and cancellation are typed, including after an awaited read and after mutation', async () => {
  const wait = api('waitForPersisted');
  const f = fixture();
  f.persist({ from: { _coldpluginIndex: 'old' } });
  await assert.rejects(wait(f.env, () => false, { timeoutMs: 1 }), { code: 'SAVE_UNCONFIRMED' });
  const early = new AbortController();
  early.abort();
  const rootCalls = f.calls.root;
  await assert.rejects(core.diagnose(f.env, { signal: early.signal }), { code: 'CANCELLED' });
  await assert.rejects(core.findCandidates(f.env, { signal: early.signal }), { code: 'CANCELLED' });
  await assert.rejects(wait(f.env, () => true, { signal: early.signal }), { code: 'CANCELLED' });
  assert.equal(f.calls.root, rootCalls);
  const late = new AbortController();
  f.onSleep(() => f.persist({ number: 101 }));
  const get = f.env.forage.getItem;
  f.env.forage.getItem = async (key) => { const value = await get(key); late.abort(); return value; };
  await assert.rejects(wait(f.env, () => true, { signal: late.signal }), { code: 'CANCELLED' });
  const g = fixture();
  g.persist();
  g.add('good', index());
  await assert.rejects(core.recover(g.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 1 }), { code: 'SAVE_UNCONFIRMED' });
  assert.equal(g.live._coldpluginIndex, 'good', 'unconfirmed save must not revert or write again');
});

test('browser env is lazy, uses injected APIs and read-only IndexedDB, aborting missing-DB upgrades', async () => {
  const create = api('createBrowserEnv');
  const transactions = [];
  let opens = 0;
  let closes = 0;
  let upgradeAborts = 0;
  let missing = true;
  const records = new Map([[DB, new Uint8Array([1, 2, 3])]]);
  const globalObj = {
    __pluginApis__: { getDatabase() {} }, __NODE__: false, __TAURI_INTERNALS__: {},
    localStorage: { getItem() { return null; } }, Blob, DecompressionStream,
    Date: { now: () => 123 }, setTimeout: (fn) => { fn(); },
    navigator: { storage: { getDirectory: async () => 'root' } },
    indexedDB: {
      open(name) {
        opens += 1;
        assert.equal(name, 'risuai');
        const request = {};
        queueMicrotask(() => {
          if (missing) {
            request.transaction = { abort() { upgradeAborts += 1; } };
            request.onupgradeneeded();
            request.onerror?.({ preventDefault() {} });
          } else {
            request.result = {
              objectStoreNames: { contains: (store) => store === 'keyvaluepairs' },
              close() { closes += 1; },
              transaction(name, mode) {
                transactions.push([name, mode]);
                const tx = { objectStore: () => ({
                  get(key) { return result(records.get(key)); },
                  getAllKeys() { return result([...records.keys()]); },
                }) };
                function result(value) {
                  const req = {};
                  queueMicrotask(() => { req.result = value; req.onsuccess(); tx.oncomplete?.(); });
                  return req;
                }
                return tx;
              },
            };
            request.onsuccess();
          }
        });
        return request;
      },
    },
  };
  const env = create(globalObj);
  assert.equal(opens, 0);
  assert.equal(env.isTauri, true);
  assert.strictEqual(env.pluginApis(), globalObj.__pluginApis__);
  assert.equal(env.now(), 123);
  assert.equal(await env.opfsRoot(), 'root');
  await env.sleep(1);
  assert.deepEqual(await env.forage.keys(), []);
  assert.equal(await env.forage.getItem(DB), null);
  assert.equal(upgradeAborts, 2);
  missing = false;
  assert.deepEqual(await env.forage.keys(), [DB]);
  assert.deepEqual(await env.forage.getItem(DB), new Uint8Array([1, 2, 3]));
  assert.deepEqual(transactions, [['keyvaluepairs', 'readonly'], ['keyvaluepairs', 'readonly']]);
  assert.equal(closes, 2);
  const stream = await env.gunzip(new Blob([gzipSync('compressed via independent fixture')]));
  assert.equal(await new Response(stream).text(), 'compressed via independent fixture');
});

test('round1 unsettled persisted databases refuse both edits without any mutation', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) {
    for (const disk of ['target', 'absent', 'unknown', 'no-block']) await t.test(`${location} ${method} ${disk}`, async () => {
      const legacy = { nested: ['keep'] };
      const f = fixture({ location, storage: { _coldpluginIndex: 'dead', legacy } });
      f.add('good', index([{ k: 'restored', s: '42' }]));
      if (disk === 'target') f.putDatabase(save({ _coldpluginIndex: 'good' }));
      if (disk === 'absent') f.putDatabase(save({}));
      if (disk === 'unknown') f.putDatabase(Buffer.from('not a save'));
      if (disk === 'no-block') f.putDatabase(Buffer.concat([Buffer.from('RISUSAVE\0'), block(0, 'root', {})]));
      const before = untouched(f);
      await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 1 }), (error) =>
        error instanceof core.FixError && error.code === 'NOT_SETTLED' && /다른.*탭/.test(error.message) && /다시/.test(error.message));
      assert.deepEqual(f.calls.writes, []);
      assert.equal(f.live._coldpluginIndex, 'dead');
      assert.strictEqual(f.live.legacy, legacy);
      assert.deepEqual(untouched(f), before);
    });
  }
});

test('round1 an initially matching disk value cannot confirm before a post-baseline save', async (t) => {
  for (const location of ['idb', 'opfs']) await t.test(location, async () => {
    const f = fixture({ location, storage: { _coldpluginIndex: 'good' } });
    f.persist({ number: 1, from: { _coldpluginIndex: 'good' } });
    let ticks = 0;
    f.onSleep(() => {
      ticks += 1;
      f.persist({ number: ticks + 1, from: { _coldpluginIndex: ticks === 1 ? 'dead' : 'good' } });
    });
    const result = await core.waitForPersisted(f.env, (pointer) => pointer === 'good', { timeoutMs: 3000 });
    assert.equal(ticks, 4, 'initially matching bytes precede a stale in-flight write; only its replacement plus settling confirms');
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'good' });
    assert.equal(stockSaveView(f.persisted()).storage._coldpluginIndex, 'good');
  });
});

test('round1 receipt baseline is captured before the live edit, including an immediate save', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) await t.test(`${location} ${method}`, async () => {
    const f = fixture({ location });
    f.add('good', index());
    f.persist({ number: 1 });
    f.onWrite(() => f.persist({ number: 2 }));
    const result = await confirms(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 3000 }));
    assert.equal(f.calls.sleeps, 4, 'the immediate save passes the pre-edit baseline gate, then the edit must settle');
    assert.deepEqual(result, { confirmed: true, persistedPointer: method === 'recover' ? 'good' : null });
    assert.equal(f.calls.writes.length, 1);
  });
});

test('round1 OPFS retries after the backup name appears before database close', async (t) => {
  for (const method of ['recover', 'reset']) await t.test(method, async () => {
    const f = fixture({ location: 'opfs' });
    f.add('good', index([{ k: 'saved', s: 'true' }]));
    f.persist({ number: 1 });
    let ticks = 0;
    f.onSleep(() => {
      ticks += 1;
      if (ticks === 1) f.files.set(hex(`${BACKUP}2.bin`), { bytes: Buffer.alloc(0), time: 1 });
      if (ticks === 2) f.putDatabase(save(f.live));
    });
    const result = await confirms(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 2000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: method === 'recover' ? 'good' : null });
    assert.equal(ticks, 4);
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), method === 'recover' ? index([{ k: 'saved', s: 'true' }]) : index());
  });
});

test('round1 IndexedDB unknown receipts retry without another backup, but retries are bounded', async (t) => {
  await t.test('transient unknown then exact saved target', async () => {
    const f = fixture();
    f.add('good', index([{ k: 'value', s: '{"kept":true}' }]));
    f.persist({ number: 1 });
    let ticks = 0;
    f.onSleep(() => {
      ticks += 1;
      if (ticks === 1) {
        f.forage.set(`${BACKUP}2.bin`, new Uint8Array());
        f.putDatabase(Buffer.from('temporarily unknown'));
      }
      if (ticks === 2) f.putDatabase(save(f.live));
    });
    const result = await core.recover(f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 2000 });
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'good' });
    assert.equal(ticks, 4);
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), index([{ k: 'value', s: '{"kept":true}' }]));
  });
  await t.test('exhausted unknown retries rearm only on a newer backup', async () => {
    const f = fixture({ storage: {} });
    f.persist({ number: 1 });
    let ticks = 0;
    const reads = [];
    f.onSleep(() => {
      ticks += 1;
      reads.push(f.calls.get.filter((key) => key === DB).length);
      if (ticks === 1) {
        f.forage.set(`${BACKUP}2.bin`, new Uint8Array());
        f.putDatabase(Buffer.from('unknown'));
      }
      if (ticks === 8) f.putDatabase(save({}));
      if (ticks === 10) f.forage.set(`${BACKUP}3.bin`, new Uint8Array());
    });
    assert.deepEqual(await core.waitForPersisted(f.env, (pointer) => pointer === null, { timeoutMs: 6000 }),
      { confirmed: true, persistedPointer: null });
    assert.equal(ticks, 10, 'exhausted IDB retries must await another backup even if bytes change');
    assert.ok(reads[7] > 1 && reads[7] <= 5, 'unknown retries are bounded, not one read or polling forever');
    assert.equal(reads[7], reads[9]);
  });
});

test('round1 a readable stale IndexedDB receipt waits for another backup, not an unannounced byte change', async () => {
  const f = fixture({ storage: { _coldpluginIndex: 'good' } });
  f.persist({ number: 1, from: { _coldpluginIndex: 'dead' } });
  let ticks = 0;
  const reads = [];
  f.onSleep(() => {
    ticks += 1;
    reads.push(f.calls.get.filter((key) => key === DB).length);
    if (ticks === 1) f.forage.set(`${BACKUP}2.bin`, new Uint8Array());
    if (ticks === 2) f.putDatabase(save({ _coldpluginIndex: 'good' }));
    if (ticks === 4) f.forage.set(`${BACKUP}3.bin`, new Uint8Array());
  });
  const result = await core.waitForPersisted(f.env, (pointer) => pointer === 'good', { timeoutMs: 3000 });
  assert.equal(ticks, 4);
  assert.equal(reads[1], reads[3], 'readable-but-stale IDB bytes do not use the unknown retry budget');
  assert.deepEqual(result, { confirmed: true, persistedPointer: 'good' });
});

test('round1 valid successor receipts survive plugin flushes and reopen their exact contents', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) await t.test(`${location} ${method}`, async () => {
    const legacy = { nested: ['keep'] };
    const f = fixture({ location, storage: { _coldpluginIndex: 'dead', legacy } });
    f.add('good', index([{ k: 'candidate', s: '1' }]));
    const successor = index([{ k: 'candidate', s: '1' }, { k: 'legacy', s: JSON.stringify(legacy) }, { k: 'new', l: 'payload' }],
      [{ id: 'good', at: 123, index: true }]);
    f.add('payload', { body: ['exact large contents'] });
    f.persist({ number: 1 });
    const coldBefore = [...f.files].filter(([name]) => name.startsWith('coldstorage_'));
    f.onSleep(() => {
      if (f.calls.sleeps !== 1) return;
      assert.deepEqual(f.calls.writes, [method === 'recover' ? ['set', '_coldpluginIndex', 'good'] : ['delete', '_coldpluginIndex']]);
      assert.strictEqual(f.live.legacy, legacy);
      assert.deepEqual([...f.files].filter(([name]) => name.startsWith('coldstorage_')), coldBefore);
      // Model the host's migration/flush, not a tool-owned cold-file write.
      f.add('successor', successor);
      f.live._coldpluginIndex = 'successor';
      f.persist({ number: 2 });
    });
    assert.deepEqual(await core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 3500 }),
      { confirmed: true, persistedPointer: 'successor' });
    assert.equal(f.calls.sleeps, 5);
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), successor);
    assert.deepEqual(JSON.parse(gunzipSync(f.files.get(coldName('payload')).bytes)), { body: ['exact large contents'] });
  });
});

test('round1 unverified successors and the original dead id never confirm', async (t) => {
  for (const method of ['recover', 'reset']) for (const state of ['missing', 'invalid', 'uncertain', 'dead']) await t.test(`${method} ${state}`, async () => {
    const storage = { _coldpluginIndex: 'dead' };
    const f = fixture({ storage });
    f.add('good', index());
    if (state === 'invalid') f.add('successor', { type: TYPE, entries: [], trash: null });
    if (state === 'uncertain') f.files.set(coldName('successor'), { bytes: Buffer.from('bad gzip'), time: 1 });
    f.persist({ number: 1 });
    f.onSleep(() => {
      if (state === 'dead') f.add('dead', index([{ k: 'resurrected-old-timeline', s: '1' }]));
      storage._coldpluginIndex = state === 'dead' ? 'dead' : 'successor';
      f.persist({ number: 2, from: { _coldpluginIndex: storage._coldpluginIndex } });
    });
    await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 3000 }), { code: 'SAVE_UNCONFIRMED' });
    assert.deepEqual(f.calls.writes, [method === 'recover' ? ['set', '_coldpluginIndex', 'good'] : ['delete', '_coldpluginIndex']]);
  });
});

test('round1 uncertain index reads never scan candidates or authorize either edit', async (t) => {
  for (const failure of ['getFile', 'getFileNotFound', 'handleTypeMismatch', 'stream', 'badCRC']) await t.test(failure, async () => {
    const f = fixture({ flags: { dosync: 'avoid' } });
    f.add('dead', index([{ k: 'recoverable', s: '42' }]));
    f.add('good', index());
    const expected = { state: 'uncertain', backend: 'web', pointer: 'dead', accountHint: true };
    if (failure === 'getFile' || failure === 'getFileNotFound') {
      f.files.get(coldName('dead')).error = Object.assign(new Error('file read failed'),
        { name: failure === 'getFile' ? 'NotAllowedError' : 'NotFoundError' });
    }
    if (failure === 'handleTypeMismatch') {
      const root = await f.env.opfsRoot();
      const get = root.getFileHandle;
      root.getFileHandle = (name, options) => name === coldName('dead')
        ? Promise.reject(Object.assign(new Error('not a file'), { name: 'TypeMismatchError' })) : get(name, options);
    }
    if (failure === 'stream') f.env.gunzip = () => new ReadableStream({ start(controller) { controller.error(new Error('I/O failed')); } });
    if (failure === 'badCRC') {
      const bytes = f.files.get(coldName('dead')).bytes;
      bytes[bytes.length - 8] ^= 1;
      assert.deepEqual(JSON.parse(inflateRawSync(bytes.subarray(10, -8)).toString()), index([{ k: 'recoverable', s: '42' }]),
        'the raw deflate payload still contains the index, as lenient stock decompression can read');
    }
    f.persist({ number: 1 });
    const before = untouched(f);
    let scans = 0;
    assert.deepEqual(await core.diagnose(f.env, { onProgress() { scans += 1; } }), expected);
    assert.equal(scans, 0);
    assert.ok(!f.calls.files.includes(coldName('good')), 'uncertain dead pointer must not trigger a candidate scan');
    for (const method of ['recover', 'reset']) {
      await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 1 }), (error) =>
        error instanceof core.FixError && error.code === 'UNCERTAIN' && /변경하지/.test(error.message));
    }
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(untouched(f), before);
  });
});

test('round1 uncertainty introduced while validating the candidate also refuses mutation', async () => {
  const f = fixture();
  f.add('good', index());
  f.persist({ number: 1 });
  f.onFile((name) => {
    if (name === coldName('good')) f.files.set(coldName('dead'), { bytes: Buffer.from('cannot decode reliably'), time: 1 });
  });
  await assert.rejects(core.recover(f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 1 }), { code: 'UNCERTAIN' });
  assert.deepEqual(f.calls.writes, []);
});

test('round1 decoded invalid indexes permit reset while uncertain candidate files are counted', async (t) => {
  for (const bytes of [gzipSync('not JSON'), gzipSync(JSON.stringify({ type: TYPE, entries: [], trash: null }))]) await t.test(bytes.toString('hex').slice(-16), async () => {
    const f = fixture();
    f.files.set(coldName('dead'), { bytes, time: 1 });
    f.add('good', index([{ k: 'keep', s: 'false' }]));
    f.files.set(coldName('io-error'), { bytes: Buffer.alloc(0), time: 1, error: new Error('I/O error') });
    f.files.set(coldName('bad-gzip'), { bytes: Buffer.from('gzip cannot decode'), time: 1 });
    f.add('bad-shape', { type: TYPE, entries: [], trash: null });
    f.persist({ number: 1 });
    const diagnosis = await core.diagnose(f.env);
    assert.equal(diagnosis.state, 'broken');
    assert.equal(diagnosis.reason, 'unreadable');
    assert.equal(diagnosis.uncertainCount, 2);
    assert.deepEqual(diagnosis.candidates, [{ id: 'good', lastModified: 1, keyCount: 1, sampleKeys: ['keep'], largeCount: 0, missingLarge: 0 }]);
    assert.deepEqual(await core.findCandidates(f.env, { excludeId: 'dead' }), diagnosis.candidates, 'public candidate API remains an array');
    f.onSleep(() => f.persist({ number: 2 }));
    assert.deepEqual(await core.reset(f.env, { pointer: 'dead', timeoutMs: 3000 }), { confirmed: true, persistedPointer: null });
    assert.equal(Object.hasOwn(f.live, '_coldpluginIndex'), false);
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), index());
  });
});

test('round1 unsupported browser capability states refuse scans and edits before storage access', async (t) => {
  for (const [capability, missing] of [['hasOpfs', 'opfs'], ['hasDecompression', 'decompression']]) await t.test(missing, async () => {
    const f = fixture();
    f.env[capability] = false;
    f.env.opfsRoot = () => assert.fail('unsupported browser OPFS access');
    f.env.forage = new Proxy({}, { get() { assert.fail('unsupported browser IDB access'); } });
    assert.deepEqual(await core.diagnose(f.env), { state: 'unsupported-browser', backend: 'web', missing });
    for (const operation of [() => core.findCandidates(f.env), () => core.recover(f.env, { pointer: 'dead', candidateId: 'good' }),
      () => core.reset(f.env, { pointer: 'dead' })]) await assert.rejects(operation, { code: 'UNSUPPORTED_BROWSER' });
    assert.deepEqual(f.calls.writes, []);
    f.local.set('accountst', 'able');
    assert.deepEqual(await core.diagnose(f.env), { state: 'unsupported-backend', backend: 'account' });
  });
});

test('round1 browser capabilities are lazy getters on the injected global object', () => {
  const globalObj = {};
  const env = core.createBrowserEnv(globalObj);
  assert.equal(env.hasOpfs, false);
  assert.equal(env.hasDecompression, false);
  assert.equal(env.opfsWritable, false);
  globalObj.navigator = { storage: { getDirectory() {} } };
  globalObj.DecompressionStream = DecompressionStream;
  globalObj.FileSystemFileHandle = function FileSystemFileHandle() {};
  globalObj.FileSystemFileHandle.prototype.createWritable = () => {};
  assert.equal(env.hasOpfs, true);
  assert.equal(env.hasDecompression, true);
  assert.equal(env.opfsWritable, true);
  globalObj.navigator.storage.getDirectory = true;
  globalObj.DecompressionStream = {};
  globalObj.FileSystemFileHandle.prototype.createWritable = true;
  assert.equal(env.hasOpfs, false);
  assert.equal(env.hasDecompression, false);
  assert.equal(env.opfsWritable, false);
});

test('round1 createWritable capability controls both database reads and repair receipts', async (t) => {
  for (const method of ['recover', 'reset']) await t.test(method, async () => {
    const f = fixture({ flags: { 'opfs_flag!': 'able' } });
    f.env.opfsWritable = false;
    f.forage.set('migrated', true);
    f.persist({ number: 1 });
    f.files.set(hex(DB), { bytes: save({ _coldpluginIndex: 'opfs-decoy' }), time: 1 });
    f.add('good', index());
    assert.equal((await core.readPersistedPointer(f.env)).pointer, 'dead', 'stock keeps IDB without createWritable');
    f.onSleep(() => f.persist({ number: 2 }));
    assert.deepEqual(await core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 3000 }),
      { confirmed: true, persistedPointer: method === 'recover' ? 'good' : null });
    assert.ok(!f.calls.files.includes(hex(DB)));
  });
});

test('round1 loaded databases without a plugin storage object are no-index, not not-ready', async (t) => {
  for (const storage of [undefined, null, 'never-used']) await t.test(String(storage), async () => {
    const f = fixture();
    f.env.pluginApis = () => ({ getDatabase: () => ({ plugins: [], pluginCustomStorage: storage }) });
    assert.deepEqual(await core.diagnose(f.env), { state: 'no-index', backend: 'web' });
    for (const method of ['recover', 'reset']) await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good' }), { code: 'NOT_BROKEN' });
    assert.equal(f.calls.root, 0);
    assert.equal(f.calls.keys, 0);
    f.local.set('accountst', 'able');
    assert.deepEqual(await core.diagnose(f.env), { state: 'unsupported-backend', backend: 'account' });
  });
});

test('round1 preflight database reads cannot hide a live pointer, backend, health or cancellation race', async (t) => {
  for (const method of ['recover', 'reset']) for (const race of ['pointer', 'backend', 'healed', 'abort']) await t.test(`${method} ${race}`, async () => {
    const f = fixture();
    const controller = new AbortController();
    f.add('good', index());
    f.persist({ number: 1 });
    const get = f.env.forage.getItem;
    f.env.forage.getItem = async (key) => {
      const bytes = await get(key);
      if (key === DB) {
        if (race === 'pointer') f.live._coldpluginIndex = 'other';
        if (race === 'backend') f.env.isNode = true;
        if (race === 'healed') f.add('dead', index([{ k: 'save-raced', s: '1' }]));
        if (race === 'abort') controller.abort();
      }
      return bytes;
    };
    await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good', signal: controller.signal, timeoutMs: 1 }),
      { code: { pointer: 'CHANGED', backend: 'UNSUPPORTED_BACKEND', healed: 'NOT_BROKEN', abort: 'CANCELLED' }[race] });
    assert.deepEqual(f.calls.writes, race === 'pointer' ? [['set', '_coldpluginIndex', 'other']] : []);
  });
});

test('round1 accountHint reflects only dosync avoid without altering candidate selection', async () => {
  const f = fixture();
  f.add('good', index([{ k: 'kept', s: '1' }]));
  const ordinary = await core.diagnose(f.env);
  f.local.set('dosync', 'avoid');
  const hinted = await core.diagnose(f.env);
  assert.equal(ordinary.accountHint, false);
  assert.equal(hinted.accountHint, true);
  assert.deepEqual(hinted, { ...ordinary, accountHint: true });
  f.local.set('dosync', 'other');
  assert.equal((await core.diagnose(f.env)).accountHint, false);
  assert.deepEqual(f.calls.writes, []);
});

// Stock ea61945: 1000 ms base plugin flush + 500 ms host idle + one 500 ms tool poll.
// Independent timing oracle: do not derive this minimum from the implementation's constants.
const SETTLE_MS = 2000;

// Model the host's immutable index commits separately from the tool's live-object writes.
function commitIndex(f, storage, id, value, { persisted = true, number } = {}) {
  f.add(id, value);
  storage._coldpluginIndex = id;
  if (persisted) f.persist({ number });
}

test('settle stale persisted S1 never confirms while the live store holds S2', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) await t.test(`${location} ${method}`, async () => {
    const legacy = { nested: ['preserved'] };
    const storage = { _coldpluginIndex: 'dead', legacy };
    const f = fixture({ location, storage });
    const s1 = index([{ k: 'legacy', s: JSON.stringify(legacy) }]);
    const s2 = index([...s1.entries, { k: 'raced', s: '"during-confirmation"' }, { k: 'large', l: 'payload' }],
      [{ id: 'S1', at: 600, index: true }]);
    f.add('good', index([{ k: 'candidate', s: '42' }]));
    f.add('payload', { exact: ['large contents'] });
    f.persist({ number: 1 });
    const before = stockSaveView(f.persisted());
    const started = f.env.now();
    f.onSleep(() => {
      if (f.calls.sleeps === 1) {
        commitIndex(f, storage, 'S1', s1, { number: 2 });
        commitIndex(f, storage, 'S2', s2, { persisted: false });
      }
      if (f.calls.sleeps === 7) f.persist({ number: 3 });
    });
    const result = await confirms(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 5000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'S2' }, 'an older valid successor is not the current store');
    assert.equal(f.env.now() - started, 3500, 'even a settled S2 must wait for its own database save');
    const after = stockSaveView(f.persisted());
    assert.equal(after.storage._coldpluginIndex, storage._coldpluginIndex);
    assert.deepEqual(reopen(f, after.storage), s2, 'reload retains every entry, large reference and trash identity');
    assert.deepEqual(JSON.parse(gunzipSync(f.files.get(coldName('payload')).bytes)), { exact: ['large contents'] });
    assert.strictEqual(f.live.legacy, legacy);
    assert.deepEqual(after.blocks.filter((b) => b.type !== 11), before.blocks.filter((b) => b.type !== 11));
    assert.deepEqual(f.calls.writes, [method === 'recover' ? ['set', '_coldpluginIndex', 'good'] : ['delete', '_coldpluginIndex']]);
  });
});

test('settle an early matching S1 receipt cannot beat S2 inside the quiet window', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) await t.test(`${location} ${method}`, async () => {
    const storage = { _coldpluginIndex: 'dead' };
    const f = fixture({ location, storage });
    f.add('good', index());
    f.persist({ number: 1 });
    const started = f.env.now();
    const s2 = index([{ k: 'raced', s: '"kept after immediate reload"' }], [{ id: 'S1', at: 1600, index: true }]);
    f.onSleep(() => {
      if (f.calls.sleeps === 1) commitIndex(f, storage, 'S1', index([{ k: 'legacy', s: 'true' }]), { number: 2 });
      if (f.calls.sleeps === 3) commitIndex(f, storage, 'S2', s2, { number: 3 });
    });
    const result = await confirms(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 5000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'S2' });
    assert.equal(f.env.now() - started, 1500 + SETTLE_MS, 'the most recent pointer change, not wait start, owns the settle clock');
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), s2);
  });
});

test('settle idle reset normalizes deleted live undefined to saved null and confirms without another backup', async (t) => {
  for (const location of ['idb', 'opfs']) await t.test(location, async () => {
    const legacy = { deep: ['keep'] };
    const f = fixture({ location, storage: { _coldpluginIndex: 'dead', legacy } });
    f.persist({ number: 1 });
    const started = f.env.now();
    f.onSleep(() => { if (f.calls.sleeps === 1) f.persist({ number: 2 }); });
    const result = await confirms(core.reset(f.env, { pointer: 'dead', timeoutMs: 5000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: null });
    assert.equal(f.env.now() - started, SETTLE_MS, 'an idle reset settles well inside the existing timeout');
    assert.equal(Object.hasOwn(f.live, '_coldpluginIndex'), false);
    assert.strictEqual(f.live.legacy, legacy);
    assert.deepEqual(stockSaveView(f.persisted()).storage, { legacy });
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), index());
    if (location === 'idb') assert.equal(f.calls.get.filter((key) => key === DB).length, 2,
      'retain the matching post-edit read: one preflight + one new-backup read, no extra saves or reads');
  });
});

test('settle recovery keeps an immediate matching receipt until quiet without needing another save', async (t) => {
  for (const location of ['idb', 'opfs']) await t.test(location, async () => {
    const f = fixture({ location });
    const wanted = index([{ k: 'restored', s: '{"exact":[1,false]}' }, { k: 'large', l: 'payload' }]);
    f.add('good', wanted);
    f.add('payload', { exact: ['payload'] });
    f.persist({ number: 1 });
    const started = f.env.now();
    f.onWrite(() => f.persist({ number: 2 }));
    const result = await confirms(core.recover(f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 5000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'good' });
    assert.equal(f.env.now() - started, SETTLE_MS, 'even an immediate durable edit needs the stock flush/save window');
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), wanted);
    assert.deepEqual(f.calls.writes, [['set', '_coldpluginIndex', 'good']]);
    if (location === 'idb') assert.equal(f.calls.get.filter((key) => key === DB).length, 2);
  });
});

test('settle continuous pointer movement times out without reverting or replaying the edit', async (t) => {
  for (const location of ['idb', 'opfs']) for (const method of ['recover', 'reset']) await t.test(`${location} ${method}`, async () => {
    const storage = { _coldpluginIndex: 'dead' };
    const f = fixture({ location, storage });
    f.add('good', index());
    f.persist({ number: 1 });
    const started = f.env.now();
    f.onSleep(() => commitIndex(f, storage, `moving-${f.calls.sleeps}`, index([{ k: 'latest', s: String(f.calls.sleeps) }]),
      { number: f.calls.sleeps + 1 }));
    await assert.rejects(core[method](f.env, { pointer: 'dead', candidateId: 'good', timeoutMs: 4000 }), (error) =>
      error instanceof core.FixError && error.code === 'SAVE_UNCONFIRMED' && error.message === '변경은 했지만, 리스 저장 파일에 반영된 것을 1분 안에 확인하지 못했어요.');
    assert.equal(f.env.now() - started, 4000);
    assert.equal(stockSaveView(f.persisted()).storage._coldpluginIndex, 'moving-8');
    assert.equal(storage._coldpluginIndex, 'moving-8');
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), index([{ k: 'latest', s: '8' }]));
    assert.deepEqual(f.calls.writes, [method === 'recover' ? ['set', '_coldpluginIndex', 'good'] : ['delete', '_coldpluginIndex']]);
  });
});

test('settle a newer unknown IDB save supersedes an earlier matching receipt', async () => {
  const f = fixture({ storage: { _coldpluginIndex: 'good' } });
  f.persist({ number: 1, from: { _coldpluginIndex: 'dead' } });
  f.onSleep(() => {
    if (f.calls.sleeps === 1) f.persist({ number: 2 });
    if (f.calls.sleeps === 3) {
      f.forage.set(`${BACKUP}3.bin`, new Uint8Array());
      f.putDatabase(Buffer.from('newer but not yet readable'));
    }
  });
  await assert.rejects(core.waitForPersisted(f.env, (pointer) => pointer === 'good', { timeoutMs: 4000 }),
    { code: 'SAVE_UNCONFIRMED' });
});

test('settle pointer movement during asynchronous successor verification resets the quiet window', async (t) => {
  for (const location of ['idb', 'opfs']) await t.test(location, async () => {
    const storage = { _coldpluginIndex: 'dead' };
    const f = fixture({ location, storage });
    f.persist({ number: 1 });
    const started = f.env.now();
    const s2 = index([{ k: 'last-write', s: '"preserved"' }]);
    let movedAt;
    f.onSleep(() => {
      if (f.calls.sleeps === 1) commitIndex(f, storage, 'S1', index(), { number: 2 });
      if (movedAt !== undefined && storage._coldpluginIndex === 'S2') f.persist({ number: 3 });
    });
    f.onFile((name) => {
      if (name === coldName('S1') && f.env.now() - started >= 2500 && movedAt === undefined) {
        movedAt = f.env.now();
        commitIndex(f, storage, 'S2', s2, { persisted: false });
      }
    });
    const result = await confirms(core.reset(f.env, { pointer: 'dead', timeoutMs: 6000 }));
    assert.deepEqual(result, { confirmed: true, persistedPointer: 'S2' }, 'use the live pointer after awaited verification');
    assert.equal(f.env.now() - movedAt, SETTLE_MS);
    assert.deepEqual(reopen(f, stockSaveView(f.persisted()).storage), s2);
  });
});

test('core bundles without CommonJS and still parses after full-line comments and newlines are removed', () => {
  assert.ok(fs.existsSync(corePath), 'contract core source must exist');
  const source = fs.readFileSync(corePath, 'utf8').split('\n').filter((line) => !line.includes('@strip-in-bundle'));
  const body = source.filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const flattened of [body.replace(/\n/g, ''), body.replace(/\n/g, ' ')]) {
    const result = vm.runInNewContext(`(() => {${flattened}; return typeof RisuPluginStorageFix.diagnose;})()`);
    assert.equal(result, 'function');
  }
});
