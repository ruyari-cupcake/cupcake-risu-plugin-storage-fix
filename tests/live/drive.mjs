// Live check of the built dist/ tool against a real RisuAI web build.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright STOCK_DIR=/path/to/risu/dist \
//     node tests/live/drive.mjs <scenario> [form]
//
// scenario: venue (harness sanity, no tool) | healthy | reset | reset-race | recover | recover-account-hint
//           | not-settled | opfs-db | account | aged-restore | aged-reset (aged = host clock moved past stock trash grace)
// form:     bookmarklet (default) | console | loader   (loader + LOCAL_CONSOLE=1 serves the hosted
//           console URL from this checkout, so it can run before a release)
// BASE_URL=https://risuai.xyz/ runs against that origin instead of serving STOCK_DIR.
//
// A tiny v3 plugin ("probe") is added to the profile so the host's real plugin storage can be
// exercised from its sandbox. Everything stateful lands in tests/live/work/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(HERE, 'work');
const HOSTED_CONSOLE_URL = 'https://ruyari-cupcake.github.io/cupcake-risu-plugin-storage-fix/dist/console.js';
const PANEL = '#cupcake-risu-plugin-storage-fix';
const PROBE_NAME = 'RPF_StorageProbe';
const INDEX_ERROR = 'Failed to load plugin storage index';
const BOOT_TIMEOUT_MS = 150000;
const STEP_TIMEOUT_MS = 60000;
const FLUSH_SETTLE_MS = 2500;
// Aged scenarios move the host clock past stock's trash grace periods (pluginStorageStore.ts L55-58:
// indexTrashGrace 1 h for old indexes, trashGrace 24 h for large values).
const CLOCK_OFFSET_KEY = '__rpfClockOffsetMs';
const HOUR_MS = 60 * 60 * 1000;
const PAST_INDEX_GRACE_MS = 2 * HOUR_MS;
const PAST_LARGE_GRACE_MS = 25 * HOUR_MS;
// risuai.xyz (BASE_URL) can take well over 20 s to reload its bundle.
const NAVIGATION_TIMEOUT_MS = 120000;

const [scenario = 'reset', form = 'bookmarklet'] = process.argv.slice(2);
const record = { scenario, form, base: null, steps: [], ok: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function step(name, data = {}) {
  record.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(`- ${name}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`);
}
function gate(ok, code, data = {}) {
  if (!ok) {
    const error = new Error(code);
    error.data = data;
    throw error;
  }
}
async function until(code, predicate, ms = STEP_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      if (await predicate()) return;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context|frame was detached|navigat/i.test(String(error?.message))) throw error;
    }
    await sleep(250);
  }
  throw new Error(code);
}

function serveStock(dir) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return res.writeHead(400).end(); }
    let file = path.resolve(dir, '.' + pathname);
    if (file !== dir && !file.startsWith(dir + path.sep)) return res.writeHead(403).end();
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) return res.writeHead(404).end();
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function boot(page, base) {
  if (base) await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const started = Date.now();
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    // The terms dialog sits on top of the onboarding buttons, so it is answered first.
    const tos = page.getByRole('button', { name: 'Accept', exact: true });
    if (await tos.isVisible().catch(() => false)) {
      await tos.click().catch(() => {});
      await sleep(1500);
      continue;
    }
    const later = page.getByRole('button', { name: 'I will setup myself', exact: true });
    if (await later.isVisible().catch(() => false)) {
      await later.click().catch(() => {});
      await sleep(1500);
      continue;
    }
    const oldLater = page.locator('.welcome-bg button').filter({ hasText: 'I will setup myself' });
    if (await oldLater.count().catch(() => 0)) {
      await oldLater.first().click().catch(() => {});
      await sleep(1500);
      continue;
    }
    // Newer onboarding asks for a nickname first; the "set up myself" choice comes after it.
    const firstSetupDone = await page.evaluate(() => !!window.__pluginApis__?.getDatabase?.()?.didFirstSetup).catch(() => false);
    const nickname = page.locator('main input').filter({ visible: true }).first();
    if (!firstSetupDone && await nickname.isVisible().catch(() => false)) {
      await nickname.fill('Plugin storage test').catch(() => {});
      await nickname.press('Enter').catch(() => {});
      await sleep(1500);
      continue;
    }
    const ready = await page.evaluate(() => !!window.__pluginApis__?.getDatabase
      && Array.isArray(window.__pluginApis__.getDatabase()?.plugins)).catch(() => false);
    const hostUi = await page.locator('button:has(svg.lucide-settings), button:has(svg.lucide-list)').filter({ visible: true }).count().catch(() => 0);
    const onboarding = await page.locator('main input').filter({ visible: true }).count().catch(() => 0);
    if (ready && hostUi && !onboarding) return;
    await sleep(400);
  }
  await page.screenshot({ path: path.join(WORK, `boot-timeout-${scenario}.png`) }).catch(() => {});
  throw new Error('BOOT_TIMEOUT');
}

async function installProbe(page) {
  await page.evaluate((name) => {
    const db = window.__pluginApis__.getDatabase();
    if (db.plugins.some((plugin) => plugin.name === name)) return;
    db.plugins.push({
      name, displayName: 'Storage Probe', script: `//@name ${name}\n//@api 3.0\nRisuai.log('probe ready');`,
      realArg: {}, arguments: {}, version: '3.0', customLink: [], argMeta: {}, versionOfPlugin: '1.0',
      updateURL: '', allowedIPC: [], enabled: true,
    });
  }, PROBE_NAME);
  await page.evaluate(() => window.__pluginApis__.loadPlugins());
}

async function probeFrame(page) {
  let found = null;
  await until('PROBE_SANDBOX_MISSING', async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frame.evaluate(() => !!window.risuai?.pluginStorage).catch(() => false)) {
        found = frame;
        return true;
      }
    }
    return false;
  });
  return found;
}

async function store(page, op, key, value) {
  const frame = await probeFrame(page);
  return frame.evaluate(async ({ op, key, value }) => {
    try {
      const storage = window.risuai.pluginStorage;
      if (op === 'get') return { ok: true, value: await storage.getItem(key) };
      if (op === 'set') { await storage.setItem(key, value); return { ok: true }; }
      return { ok: true, value: await storage.keys() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }, { op, key, value });
}

const pointer = (page) => page.evaluate(() => {
  const value = window.__pluginApis__.getDatabase().pluginCustomStorage?._coldpluginIndex;
  return value === undefined ? null : value;
});

async function coldFiles(page, action) {
  return page.evaluate(async (action) => {
    const dir = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of dir.entries()) if (name.startsWith('coldstorage_')) names.push(name);
    if (action === 'delete') for (const name of names) await dir.removeEntry(name);
    return names.sort();
  }, action);
}

// The live pluginCustomStorage next to the pluginStorage block of the saved database/database.bin.
// The parser follows stock ts/storage/risuSave.ts directly (header "RISUSAVE\0"; block = type,
// compression flag, name length, name, uint32 length, data; PLUGIN_STORAGE = 11) and deliberately
// shares no code with the tool, so the harness never checks the tool with the tool's own reader.
// Exactly one database file may exist (OPFS hex-named file or IndexedDB `risuai`): with both,
// which one stock reads depends on flags and migration state, so the oracle refuses to guess.
// Live is sampled after every await, so a value that moved during parsing never compares equal.
async function savedVsLive(page) {
  return page.evaluate(async () => {
    const key = 'database/database.bin';
    const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, '0')).join('');
    let opfsBytes = null;
    try {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(hex)).getFile();
      opfsBytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {}
    // Opening a missing database would create it; only an existing `risuai` database is read.
    const idbExists = (await indexedDB.databases()).some((db) => db.name === 'risuai');
    const idbBytes = !idbExists ? null : await new Promise((resolve) => {
      const open = indexedDB.open('risuai');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('keyvaluepairs')) { db.close(); resolve(null); return; }
        const request = db.transaction('keyvaluepairs').objectStore('keyvaluepairs').get(key);
        request.onsuccess = () => {
          db.close();
          const value = request.result;
          resolve(value ? new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer || value) : null);
        };
        request.onerror = () => { db.close(); resolve(null); };
      };
      open.onerror = () => resolve(null);
    });
    const canonical = (value) => JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((name) => [name, v[name]])) : v));
    const liveNow = () => canonical(window.__pluginApis__.getDatabase().pluginCustomStorage ?? null);
    if (opfsBytes && idbBytes) return { live: liveNow(), saved: null, ambiguous: true };
    const bytes = opfsBytes || idbBytes;
    const header = 'RISUSAVE\0';
    if (!bytes || new TextDecoder().decode(bytes.subarray(0, header.length)) !== header) return { live: liveNow(), saved: null };
    let offset = header.length;
    let saved = null;
    while (offset + 7 <= bytes.length) {
      const type = bytes[offset];
      const compressed = bytes[offset + 1] === 1;
      const nameLength = bytes[offset + 2];
      const name = new TextDecoder().decode(bytes.subarray(offset + 3, offset + 3 + nameLength));
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 3 + nameLength, 4).getUint32(0, true);
      let data = bytes.subarray(offset + 7 + nameLength, offset + 7 + nameLength + length);
      offset += 7 + nameLength + length;
      if (type !== 11 || name !== 'pluginStorage') continue;
      if (compressed) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      saved = canonical(JSON.parse(new TextDecoder().decode(data)));
    }
    return { live: liveNow(), saved };
  });
}

// Where the host keeps database/database.bin: OPFS (hex-named root file) or IndexedDB `risuai`.
async function databaseLocation(page) {
  return page.evaluate(async () => {
    const hex = Array.from(new TextEncoder().encode('database/database.bin'), (b) => b.toString(16).padStart(2, '0')).join('');
    const dir = await navigator.storage.getDirectory();
    let opfs = false;
    try { await dir.getFileHandle(hex); opfs = true; } catch (error) {}
    const idbExists = (await indexedDB.databases()).some((db) => db.name === 'risuai');
    const idb = !idbExists ? false : await new Promise((resolve) => {
      const open = indexedDB.open('risuai');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('keyvaluepairs')) { db.close(); resolve(false); return; }
        const request = db.transaction('keyvaluepairs').objectStore('keyvaluepairs').getKey('database/database.bin');
        request.onsuccess = () => { db.close(); resolve(request.result !== undefined); };
        request.onerror = () => { db.close(); resolve(false); };
      };
      open.onerror = () => resolve(false);
    });
    return { opfs, idb };
  });
}

// Waits until the saved database holds exactly the live plugin storage. A backup timestamp is no
// proof: stock saves 0-500 ms after a change and then stops saving, so a fixed "newer than
// change + N ms" threshold either misses a fast save forever or accepts a save that began
// before the change.
async function waitHostSaved(page) {
  let last = null;
  try {
    await until('HOST_SAVE_TIMEOUT', async () => {
      last = await savedVsLive(page);
      return last.saved !== null && last.saved === last.live;
    });
  } catch (error) {
    error.data = last;
    throw error;
  }
}

async function runTool(page) {
  if (form === 'console') {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIST, 'console.js'), 'utf8') });
  } else if (form === 'loader') {
    const loader = fs.readFileSync(path.join(DIST, 'loader-bookmarklet.txt'), 'utf8').trim();
    await page.evaluate(loader.slice('javascript:'.length));
  } else {
    const url = fs.readFileSync(path.join(DIST, 'bookmarklet.txt'), 'utf8').trim();
    await page.evaluate(decodeURIComponent(url.slice('javascript:'.length)));
  }
  await until('PANEL_MISSING', () => page.locator(PANEL).count().then((n) => n === 1));
}

async function panelStatus(page, pattern) {
  let text = '';
  await until(`PANEL_STATUS_${pattern}`, async () => {
    text = await page.locator(`${PANEL} .status`).innerText();
    return pattern.test(text);
  }, 90000);
  return text;
}

async function reloadFromPanel(page) {
  const navigation = page.waitForNavigation({ timeout: NAVIGATION_TIMEOUT_MS });
  await page.locator(`${PANEL} button.reload`).click();
  await navigation;
  await boot(page, null);
  await installProbeIfMissing(page);
}

async function installProbeIfMissing(page) {
  const present = await page.evaluate((name) => window.__pluginApis__.getDatabase().plugins.some((p) => p.name === name), PROBE_NAME);
  gate(present, 'PROBE_PLUGIN_LOST_ON_RELOAD');
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await boot(page, null);
}

// Saves first (a pending write must not be lost by the reload), then reopens the page `ms` later on
// the host clock and proves the shift took effect.
async function advanceClock(page, ms) {
  await waitHostSaved(page);
  const total = await page.evaluate(({ key, ms }) => {
    const next = Number(localStorage.getItem(key) || 0) + ms;
    localStorage.setItem(key, String(next));
    return next;
  }, { key: CLOCK_OFFSET_KEY, ms });
  await reload(page);
  const ahead = await page.evaluate(() => Date.now() - performance.timeOrigin - performance.now());
  gate(ahead >= total - 60000, 'CLOCK_NOT_SHIFTED', { ahead, total });
  step('host clock moved ahead', { hours: Math.round(total / HOUR_MS) });
}

// Proves the store reads every expected value, the dead id never came back, and the pointer's
// index file exists.
async function expectValues(page, expected, dead) {
  for (const [key, value] of Object.entries(expected)) {
    const read = await store(page, 'get', key);
    gate(read.ok && JSON.stringify(read.value) === JSON.stringify(value), 'VALUE_WRONG', { key, read, value });
  }
  const now = await pointer(page);
  gate(now !== dead, 'DEAD_POINTER_CAME_BACK', { now });
  gate(now === null || (await coldFiles(page, 'list')).includes(`coldstorage_${now}.json`), 'POINTER_HAS_NO_FILE', { now });
}

async function seed(page, entries) {
  for (const [key, value] of entries) {
    const result = await store(page, 'set', key, value);
    gate(result.ok, 'SEED_WRITE_FAILED', result);
    await sleep(FLUSH_SETTLE_MS);
  }
  await until('POINTER_NOT_WRITTEN', async () => typeof (await pointer(page)) === 'string');
}

async function expectDead(page) {
  const read = await store(page, 'get', 'alpha');
  gate(!read.ok && read.error.includes(INDEX_ERROR), 'NOT_DEAD_AFTER_BREAK', read);
  step('dead state reproduced', { error: read.error.slice(0, 80) });
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  gate(scenario === 'venue' || fs.existsSync(path.join(DIST, 'console.js')), 'RUN_NPM_BUILD_FIRST');
  let server = null;
  let base = process.env.BASE_URL || null;
  if (!base) {
    gate(!!process.env.STOCK_DIR && fs.existsSync(path.join(process.env.STOCK_DIR, 'index.html')), 'STOCK_DIR_REQUIRED');
    ({ server, base } = await serveStock(path.resolve(process.env.STOCK_DIR)));
  }
  record.base = base;
  const profile = fs.mkdtempSync(path.join(WORK, `profile-${scenario}-`));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 }, locale: 'en-US', args: ['--no-sandbox'] });
  try {
    await context.addInitScript(({ opfs, clockKey }) => {
      globalThis.__RISU_LEGAL_CONFIGURED__ = true;
      try {
        if (opfs && window === window.top && !localStorage.getItem('opfs_flag!')) localStorage.setItem('opfs_flag!', 'able');
      } catch (error) {}
      // Aged scenarios: the host page's wall clock runs ahead by a stored offset (fixed for the page's
      // lifetime, so durations stay real). Stock code is untouched; only "now" moves, as if the user
      // came back hours later. Stock trash grace compares Date.now() (pluginStorageStore.ts L318-343).
      try {
        const offset = window === window.top ? Number(localStorage.getItem(clockKey) || 0) : 0;
        if (offset > 0) {
          const RealDate = Date;
          const shiftedNow = () => RealDate.now() + offset;
          globalThis.Date = new Proxy(RealDate, {
            construct: (target, args, newTarget) => (args.length ? Reflect.construct(target, args, newTarget) : Reflect.construct(target, [shiftedNow()], newTarget)),
            apply: (target) => new target(shiftedNow()).toString(),
            get: (target, prop, receiver) => (prop === 'now' ? shiftedNow : Reflect.get(target, prop, receiver)),
          });
        }
      } catch (error) {}
    }, { opfs: scenario === 'opfs-db', clockKey: CLOCK_OFFSET_KEY });
    if (form === 'loader' && process.env.LOCAL_CONSOLE === '1') {
      await context.route(HOSTED_CONSOLE_URL, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(DIST, 'console.js'), 'utf8') }));
    }
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(20000);
    // risuai.xyz asks "leave site?" on every navigation (stock preload.ts, isWeb); a user answers it
    // by confirming the reload, so the driver accepts exactly that kind and dismisses the rest.
    page.on('dialog', (dialog) => {
      (record.dialogs ||= []).push({ type: dialog.type(), message: dialog.message().slice(0, 200) });
      (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on('pageerror', (error) => { (record.pageErrors ||= []).push(String(error?.message || error).slice(0, 200)); });

    await boot(page, base);
    step('host booted', { version: await page.evaluate(() => document.title) });
    await installProbe(page);
    await probeFrame(page);
    step('probe plugin running');

    if (scenario === 'venue') {
      // Venue sanity only (no tool): the probe can write, and deleting the cold files reproduces the dead state.
      await seed(page, [['alpha', 1]]);
      await waitHostSaved(page);
      const deleted = await coldFiles(page, 'delete');
      step('cold files deleted', { count: deleted.length });
      await reload(page);
      await expectDead(page);
    } else if (scenario === 'healthy') {
      await seed(page, [['alpha', 1]]);
      const before = await pointer(page);
      await runTool(page);
      const text = await panelStatus(page, /정상이에요/);
      step('tool says healthy', { text: text.split('\n')[0] });
      gate((await pointer(page)) === before, 'HEALTHY_POINTER_CHANGED');
      gate(!(await page.locator(`${PANEL} button.reset`).isVisible()), 'HEALTHY_OFFERS_RESET');
    } else if (scenario === 'account') {
      await seed(page, [['alpha', 1]]);
      const before = await pointer(page);
      const deleted = await coldFiles(page, 'delete');
      step('cold files deleted', { count: deleted.length });
      await page.evaluate(() => localStorage.setItem('accountst', 'able'));
      await runTool(page);
      const text = await panelStatus(page, /계정 저장 모드/);
      step('tool refuses account mode', { text: text.split('\n')[0] });
      gate((await pointer(page)) === before, 'ACCOUNT_POINTER_CHANGED');
      gate(!(await page.locator(`${PANEL} button.reset`).isVisible()), 'ACCOUNT_OFFERS_RESET');
      await page.evaluate(() => localStorage.removeItem('accountst'));
    } else if (scenario === 'reset' || scenario === 'opfs-db' || scenario === 'reset-race') {
      // reset-race: a plugin writes right after the pointer is cleared, so the store flushes a NEW
      // index before the host saves; the tool must still confirm (a verified successor) and the
      // raced value must survive the reload.
      const race = scenario === 'reset-race';
      await seed(page, [['alpha', 1], ['beta', 'two']]);
      const location = await databaseLocation(page);
      step('host database location', location);
      gate(location.opfs !== location.idb, 'DATABASE_LOCATION_AMBIGUOUS', location);
      gate(location.opfs === (scenario === 'opfs-db'), 'DATABASE_LOCATION_NOT_EXERCISED', location);
      await page.evaluate(() => { window.__pluginApis__.getDatabase().pluginCustomStorage.rpfLegacyInline = 'keep-me'; });
      await waitHostSaved(page);
      const dead = await pointer(page);
      const deleted = await coldFiles(page, 'delete');
      step('cold files deleted (OPFS eviction)', { pointer: dead, count: deleted.length });
      await reload(page);
      await expectDead(page);
      await runTool(page);
      const text = await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      step('tool diagnoses missing index', { text: text.split('\n')[0] });
      gate(await page.locator(`${PANEL} .detail`).innerText().then((t) => t.includes('찾지 못했어요')), 'EXPECTED_NO_CANDIDATES');
      gate(!(await page.locator(`${PANEL} button.recover`).isVisible()), 'RECOVER_OFFERED_WITHOUT_CANDIDATES');
      await page.locator(`${PANEL} button.reset`).click();
      gate(await page.locator(`${PANEL} button.do-reset`).isDisabled(), 'RESET_NOT_GUARDED_BY_CHECKBOX');
      await page.locator(`${PANEL} input.agree`).check();
      await page.locator(`${PANEL} button.do-reset`).click();
      if (race) {
        // Write only once the live pointer is gone (before that the store still rejects), and
        // before the save receipt arrives (the host debounces its save by 500 ms).
        await until('POINTER_NOT_CLEARED', async () => (await pointer(page)) !== dead, 20000);
        const raced = await store(page, 'set', 'raced', 'during-confirmation');
        gate(raced.ok, 'RACED_WRITE_FAILED', raced);
        step('plugin wrote while the tool was confirming');
      }
      const done = await panelStatus(page, /✅|⚠|❌/);
      gate(done.startsWith('✅'), 'RESET_NOT_CONFIRMED', { done });
      step('reset confirmed by tool', { text: done.split('\n')[0] });
      const memoryPointer = await pointer(page);
      gate(race ? memoryPointer !== dead : memoryPointer === null, 'POINTER_STILL_SET_IN_MEMORY', { memoryPointer });
      await reloadFromPanel(page);
      // The store may legitimately write a NEW index right away (it migrates legacy inline values
      // on its first load), so the check is: never the dead pointer again, and any pointer is readable.
      const after = await pointer(page);
      const coldAfter = await coldFiles(page, 'list');
      step('pointer after reload', { after, dead, newIndexFile: after ? coldAfter.includes(`coldstorage_${after}.json`) : null });
      gate(after !== dead, 'DEAD_POINTER_CAME_BACK_AFTER_RELOAD', { after });
      gate(after === null || coldAfter.includes(`coldstorage_${after}.json`), 'NEW_POINTER_HAS_NO_FILE', { after });
      const inline = await store(page, 'get', 'rpfLegacyInline');
      gate(inline.ok && inline.value === 'keep-me', 'OTHER_KEY_LOST', inline);
      const gone = await store(page, 'get', 'alpha');
      gate(gone.ok && gone.value === null, 'RESET_STORE_NOT_USABLE', gone);
      if (race) {
        const raced = await store(page, 'get', 'raced');
        gate(raced.ok && raced.value === 'during-confirmation', 'RACED_VALUE_LOST', raced);
      }
      const write = await store(page, 'set', 'gamma', { after: 'reset' });
      gate(write.ok, 'WRITE_AFTER_RESET_FAILED', write);
      await sleep(FLUSH_SETTLE_MS);
      await waitHostSaved(page);
      await reload(page);
      const reread = await store(page, 'get', 'gamma');
      gate(reread.ok && reread.value?.after === 'reset', 'WRITE_AFTER_RESET_NOT_PERSISTED', reread);
      step('store works after reset and persists across reload', { keys: (await store(page, 'keys')).value });
    } else if (scenario === 'recover') {
      await seed(page, [['alpha', 1]]);
      await seed(page, [['alpha', 2], ['beta', 'latest']]);
      const newest = await pointer(page);
      // An older database restored over the profile points at an index that no longer exists,
      // while the newest index is still on disk.
      await page.evaluate(() => { window.__pluginApis__.getDatabase().pluginCustomStorage._coldpluginIndex = crypto.randomUUID(); });
      await waitHostSaved(page);
      step('pointer moved to a missing index', { newest });
      await reload(page);
      await expectDead(page);
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      const first = page.locator(`${PANEL} input[name="candidate"]`).first();
      gate((await first.getAttribute('value')) === newest && await first.isChecked(), 'NEWEST_NOT_FIRST_CHOICE', { first: await first.getAttribute('value'), newest });
      step('newest surviving index offered first', { candidates: await page.locator(`${PANEL} input[name="candidate"]`).count() });
      await page.locator(`${PANEL} button.recover`).click();
      const done = await panelStatus(page, /✅|⚠|❌/);
      gate(done.startsWith('✅'), 'RECOVER_NOT_CONFIRMED', { done });
      await reloadFromPanel(page);
      gate((await pointer(page)) === newest, 'RECOVERED_POINTER_LOST_AFTER_RELOAD');
      const alpha = await store(page, 'get', 'alpha');
      const beta = await store(page, 'get', 'beta');
      gate(alpha.ok && alpha.value === 2 && beta.ok && beta.value === 'latest', 'RECOVERED_VALUES_WRONG', { alpha, beta });
      step('recovered values readable after reload', { alpha: alpha.value, beta: beta.value });
    } else if (scenario === 'recover-account-hint') {
      // A browser that used Risu account storage and logged out / declined sync (stock sets
      // localStorage.dosync = 'avoid'): the panel must warn first and preselect nothing.
      await seed(page, [['alpha', 1]]);
      await seed(page, [['alpha', 2], ['beta', 'latest']]);
      const newest = await pointer(page);
      await page.evaluate(() => { window.__pluginApis__.getDatabase().pluginCustomStorage._coldpluginIndex = crypto.randomUUID(); });
      await waitHostSaved(page);
      await reload(page);
      await expectDead(page);
      await page.evaluate(() => localStorage.setItem('dosync', 'avoid'));
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      const detailText = await page.locator(`${PANEL} .detail`).innerText();
      gate(detailText.includes('먼저 확인해 주세요') && detailText.includes('계정'), 'ACCOUNT_HINT_NOT_SHOWN', { detailText: detailText.slice(0, 300) });
      gate(await page.locator(`${PANEL} input[name="candidate"]:checked`).count() === 0, 'CANDIDATE_PRESELECTED_WITH_ACCOUNT_HINT');
      step('account hint shown, nothing preselected');
      await page.locator(`${PANEL} button.recover`).click();
      await panelStatus(page, /시점을 하나 골라 주세요/);
      gate(await page.locator(`${PANEL} button.recover`).isVisible(), 'RECOVER_BUTTON_LOST_AFTER_EMPTY_PICK');
      gate((await pointer(page)) !== newest, 'EMPTY_PICK_CHANGED_POINTER');
      step('recover without a pick asks for one and changes nothing');
      await page.locator(`${PANEL} input[name="candidate"][value="${newest}"]`).check();
      await page.locator(`${PANEL} button.recover`).click();
      const done = await panelStatus(page, /✅|⚠|❌ (?!플러그인 저장소 목차)/);
      gate(done.startsWith('✅'), 'RECOVER_NOT_CONFIRMED', { done });
      await page.evaluate(() => localStorage.removeItem('dosync'));
      await reloadFromPanel(page);
      gate((await pointer(page)) === newest, 'RECOVERED_POINTER_LOST_AFTER_RELOAD');
      await expectValues(page, { alpha: 2, beta: 'latest' }, null);
      step('deliberately picked index recovered and readable after reload');
    } else if (scenario === 'not-settled') {
      // Another Risu tab announces itself on stock's `risu-db` channel, so this tab stops saving
      // (globalApi.svelte.ts L296-312, L438-442). Memory then moves to a different missing index
      // that never reaches the disk: the tool must refuse (NOT_SETTLED), change nothing, and offer
      // the reload its message asks for; after that reload the normal repair works.
      await seed(page, [['alpha', 1]]);
      await waitHostSaved(page);
      const dead = await pointer(page);
      await coldFiles(page, 'delete');
      await reload(page);
      await expectDead(page);
      await page.evaluate(() => new BroadcastChannel('risu-db').postMessage('rpf-other-tab'));
      await sleep(1500);
      const diverged = await page.evaluate(() => {
        const id = crypto.randomUUID();
        window.__pluginApis__.getDatabase().pluginCustomStorage._coldpluginIndex = id;
        return id;
      });
      await sleep(3000);
      const saved = await savedVsLive(page);
      gate(saved.saved !== saved.live, 'HOST_STILL_SAVING_DESPITE_OTHER_TAB', saved);
      step('another tab took over saving; memory diverged from the saved file', { dead, diverged });
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      await page.locator(`${PANEL} button.reset`).click();
      await page.locator(`${PANEL} input.agree`).check();
      await page.locator(`${PANEL} button.do-reset`).click();
      const refused = await panelStatus(page, /⚠|✅|❌ (?!플러그인 저장소 목차)/);
      gate(refused.startsWith('⚠') && refused.includes('일치하지 않아'), 'NOT_SETTLED_NOT_SHOWN', { refused });
      gate(await page.locator(`${PANEL} button.reload`).isVisible(), 'NOT_SETTLED_HIDES_RELOAD');
      gate(await page.locator(`${PANEL} button.rerun`).isVisible(), 'NOT_SETTLED_HIDES_RERUN');
      gate((await pointer(page)) === diverged, 'NOT_SETTLED_CHANGED_POINTER');
      step('tool refused with NOT_SETTLED, changed nothing, offers reload', { text: refused.split('\n')[0] });
      await reloadFromPanel(page);
      gate((await pointer(page)) === dead, 'UNSAVED_DIVERGENCE_PERSISTED', { now: await pointer(page) });
      await expectDead(page);
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      await page.locator(`${PANEL} button.reset`).click();
      await page.locator(`${PANEL} input.agree`).check();
      await page.locator(`${PANEL} button.do-reset`).click();
      const done = await panelStatus(page, /✅|⚠|❌ (?!플러그인 저장소 목차)/);
      gate(done.startsWith('✅'), 'RESET_NOT_CONFIRMED', { done });
      await reloadFromPanel(page);
      await expectValues(page, { alpha: null }, dead);
      step('after the reload the normal reset confirms and the store works');
    } else if (scenario === 'aged-restore') {
      // The natural dead state: an older database (pointing at index A) comes back after stock has
      // already deleted A once its trash grace passed. Nothing is deleted by hand here.
      await seed(page, [['alpha', 1]]);
      await waitHostSaved(page);
      const old = await pointer(page);
      await seed(page, [['alpha', 2], ['beta', 'latest']]);
      const newest = await pointer(page);
      gate(old !== newest, 'SEED_DID_NOT_MOVE_POINTER');
      await advanceClock(page, PAST_INDEX_GRACE_MS);
      await expectValues(page, { alpha: 2, beta: 'latest' }, null);
      await until('OLD_INDEX_NOT_COLLECTED', async () => !(await coldFiles(page, 'list')).includes(`coldstorage_${old}.json`));
      step('stock deleted the old index after its trash grace', { old, newest });
      await page.evaluate((id) => { window.__pluginApis__.getDatabase().pluginCustomStorage._coldpluginIndex = id; }, old);
      await waitHostSaved(page);
      await reload(page);
      await expectDead(page);
      step('older database restored over the profile → dead state');
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      const first = page.locator(`${PANEL} input[name="candidate"]`).first();
      gate((await first.getAttribute('value')) === newest && await first.isChecked(), 'NEWEST_NOT_FIRST_CHOICE', { first: await first.getAttribute('value'), newest });
      await page.locator(`${PANEL} button.recover`).click();
      const done = await panelStatus(page, /✅|⚠|❌ (?!플러그인 저장소 목차)/);
      gate(done.startsWith('✅'), 'RECOVER_NOT_CONFIRMED', { done });
      await reloadFromPanel(page);
      gate((await pointer(page)) === newest, 'RECOVERED_POINTER_LOST_AFTER_RELOAD');
      await expectValues(page, { alpha: 2, beta: 'latest' }, old);
      step('recovered, values readable');
      const write = await store(page, 'set', 'gamma', { after: 'recover' });
      gate(write.ok, 'WRITE_AFTER_RECOVER_FAILED', write);
      await sleep(FLUSH_SETTLE_MS);
      await advanceClock(page, PAST_INDEX_GRACE_MS);
      await expectValues(page, { alpha: 2, beta: 'latest', gamma: { after: 'recover' } }, old);
      await advanceClock(page, PAST_LARGE_GRACE_MS);
      await expectValues(page, { alpha: 2, beta: 'latest', gamma: { after: 'recover' } }, old);
      step('values survive +2 h and +27 h reloads (stock trash collection ran each time)');
      await runTool(page);
      await panelStatus(page, /정상이에요/);
      gate(!(await page.locator(`${PANEL} button.reset`).isVisible()), 'HEALTHY_OFFERS_RESET');
      step('running the tool again later says healthy');
    } else if (scenario === 'aged-reset') {
      // Days later the browser evicted the cold files (OPFS) but kept the database.
      await seed(page, [['alpha', 1], ['beta', 'two']]);
      await page.evaluate(() => { window.__pluginApis__.getDatabase().pluginCustomStorage.rpfLegacyInline = 'keep-me'; });
      await waitHostSaved(page);
      const dead = await pointer(page);
      await advanceClock(page, 3 * 24 * HOUR_MS);
      const deleted = await coldFiles(page, 'delete');
      step('cold files evicted days later', { count: deleted.length });
      await reload(page);
      await expectDead(page);
      await runTool(page);
      await panelStatus(page, /목차 파일이 이 브라우저에 없어요/);
      await page.locator(`${PANEL} button.reset`).click();
      await page.locator(`${PANEL} input.agree`).check();
      await page.locator(`${PANEL} button.do-reset`).click();
      const done = await panelStatus(page, /✅|⚠|❌ (?!플러그인 저장소 목차)/);
      gate(done.startsWith('✅'), 'RESET_NOT_CONFIRMED', { done });
      await reloadFromPanel(page);
      await expectValues(page, { rpfLegacyInline: 'keep-me', alpha: null }, dead);
      const write = await store(page, 'set', 'gamma', { after: 'reset' });
      gate(write.ok, 'WRITE_AFTER_RESET_FAILED', write);
      await sleep(FLUSH_SETTLE_MS);
      for (const ms of [PAST_INDEX_GRACE_MS, PAST_LARGE_GRACE_MS]) {
        await advanceClock(page, ms);
        await expectValues(page, { rpfLegacyInline: 'keep-me', alpha: null, gamma: { after: 'reset' } }, dead);
      }
      step('reset store stays healthy across +2 h and +27 h reloads');
      await runTool(page);
      await panelStatus(page, /정상이에요/);
      gate(!(await page.locator(`${PANEL} button.reset`).isVisible()), 'HEALTHY_OFFERS_RESET');
      step('running the tool again later says healthy');
    } else {
      throw new Error(`unknown scenario ${scenario}`);
    }
    record.ok = true;
  } catch (error) {
    record.error = { code: error.message, data: error.data };
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: path.join(WORK, `failure-${scenario}-${form}.png`) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.writeFileSync(path.join(WORK, `result-${scenario}-${form}.json`), JSON.stringify(record, null, 2));
    console.log(record.ok ? `PASS ${scenario} (${form})` : `FAIL ${scenario} (${form}): ${record.error?.code}`);
  }
}

main();
