'use strict';
// Design probe (account mode, official risuai.xyz, TEST account only): how can a page-context tool confirm that stock
// saved a live database edit to the account server, cheaply? Measures: the IndexedDB cache stock writes on every
// account save (`risuaiAccountCached`: `database/database.bin` + `__date`), the hub DB read with a matching
// `x-risu-save-date` (303 {match}?) vs a wrong one, and whether a `pluginCustomStorage` edit reaches both.
// Records statuses / booleans / lengths only — never a token. Needs TEST creds in ~/.config/cpm-secrets/risu-test-account.env.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/cupcake/workspace/cupcake/Playwright/workspace/node_modules/playwright');

const OUT = path.join(__dirname, 'work');
fs.mkdirSync(OUT, { recursive: true });
const RESULT = path.join(OUT, 'result-account-save-probe.json');
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.config/cpm-secrets/risu-test-account.env'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const R = { startedAt: new Date().toISOString(), steps: {} };
const save = () => fs.writeFileSync(RESULT, JSON.stringify(R, null, 2));
const log = (k, v) => { R.steps[k] = v; save(); console.log(JSON.stringify({ step: k, ...v })); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, ms = 120000, every = 1000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => false); if (v) return v; if (Date.now() > end) throw new Error('TIMEOUT_' + label); await delay(every); }
}

// Page-side helpers: read the account cache and the hub DB, parse the pluginStorage block (RISUSAVE layout per
// stock risuSave.ts), never return the token.
const PAGE_HELPERS = `
window.__rpfProbe = {
  async cache() {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('risuaiAccountCached'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const names = [...db.objectStoreNames];
    if (!names.includes('keyvaluepairs')) { db.close(); return { names }; }
    const get = (k) => new Promise((res, rej) => { const t = db.transaction('keyvaluepairs', 'readonly'); const q = t.objectStore('keyvaluepairs').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const bin = await get('database/database.bin');
    const date = await get('database/database.bin__date');
    db.close();
    return { bin, date };
  },
  async gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); },
  async block(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const magic = [82,73,83,85,83,65,86,69,0];
    if (!magic.every((b, i) => u[i] === b)) return { format: 'unknown' };
    let o = 9;
    while (o < u.length) {
      const type = u[o], comp = u[o + 1], nl = u[o + 2]; o += 3;
      const name = new TextDecoder().decode(u.subarray(o, o + nl)); o += nl;
      const len = new DataView(u.buffer, u.byteOffset + o, 4).getUint32(0, true); o += 4;
      if (type === 11 && name === 'pluginStorage') {
        let d = u.subarray(o, o + len);
        const head = Array.from(d.subarray(0, 4));
        try {
          if (comp === 1) d = await this.gunzip(d);
          return { format: 'risusave', storage: JSON.parse(new TextDecoder().decode(d)), comp, len };
        } catch (e) {
          return { format: 'risusave', storage: null, comp, len, head, error: String(e && e.message || e).slice(0, 80) };
        }
      }
      o += len;
    }
    return { format: 'risusave', storage: null };
  },
  token() { try { return JSON.parse(localStorage.getItem('fallbackRisuToken') || 'null')?.token || ''; } catch { return ''; } },
  async hubRead(saveDate) {
    const key = 'database/database.bin';
    const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch('https://sv.risuai.xyz/api/account/read/' + hex + '|' + crypto.randomUUID(), { headers: { 'x-risu-key': key, 'x-risu-save-date': String(saveDate), 'x-risu-auth': this.token() } });
    const out = { status: r.status, type: r.headers.get('content-type') };
    if (r.status === 303 || (out.type || '').includes('json')) { out.json = await r.json().catch(() => null); return out; }
    if (r.status === 200) { const b = new Uint8Array(await r.arrayBuffer()); out.size = b.length; out.block = await this.block(b); }
    return out;
  },
};`;

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-acct-probe-'));
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 }, locale: 'en-US', args: ['--no-sandbox'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  try {
    await page.goto('https://risuai.xyz/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await until('BOOT', async () => {
      for (const name of ['Accept', 'I will setup myself']) {
        const b = page.getByRole('button', { name, exact: true });
        if (await b.isVisible().catch(() => false)) { await b.click(); return false; }
      }
      const done = await page.evaluate(() => !!window.__pluginApis__?.getDatabase?.()?.didFirstSetup).catch(() => false);
      const nick = page.locator('main input').filter({ visible: true }).first();
      if (!done && await nick.isVisible().catch(() => false)) { await nick.fill('probe'); await nick.press('Enter'); return false; }
      return await page.evaluate(() => !!window.__pluginApis__?.getDatabase && Array.isArray(window.__pluginApis__.getDatabase()?.plugins))
        && await page.locator('button:has(svg.lucide-settings), button:has(svg.lucide-list)').filter({ visible: true }).count() > 0;
    }, 180000, 1500);
    let gear = page.locator('button:has(svg.lucide-settings)').filter({ visible: true });
    if (!await gear.count()) { await page.locator('button:has(svg.lucide-list)').filter({ visible: true }).first().click(); await delay(800); gear = page.locator('button:has(svg.lucide-settings)').filter({ visible: true }); }
    await gear.first().click();
    await delay(1500);
    await page.locator('.rs-setting-cont button, .rs-setting-cont-3 button').filter({ hasText: /^\s*Account/ }).first().click();
    await delay(1500);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const frame = page.frameLocator('iframe[title="login"]');
    await frame.locator('#id').fill(env.RISU_TEST_ID);
    await frame.locator('#password').fill(env.RISU_TEST_PASSWORD);
    await frame.locator('button[type="submit"]').click();
    await until('LOGIN', async () => (await page.locator('body').innerText()).includes('ID: ' + env.RISU_TEST_ID), 60000);
    await page.getByText('Save Data in Account', { exact: true }).first().click();
    // The account already holds a database → stock asks load / save / cancel. "Save" exercises the upload path.
    await until('SYNC', async () => {
      const save = page.getByRole('button', { name: 'Save Current Data to Account', exact: true });
      if (await save.isVisible().catch(() => false)) { await save.click(); return false; }
      const body = await page.locator('body').innerText();
      const input = page.locator('input').filter({ visible: true });
      if (body.includes('type "RISUAI"') && await input.count()) { await input.last().fill('RISUAI'); await page.getByRole('button', { name: 'OK', exact: true }).click(); return true; }
      return false;
    }, 120000);
    await until('ACCOUNT_MODE', async () => (await page.evaluate(() => localStorage.getItem('accountst'))) === 'able', 120000);
    await delay(4000);
    await page.addScriptTag({ content: PAGE_HELPERS });

    const snap = async (label) => {
      const v = await page.evaluate(async () => {
        const p = window.__rpfProbe;
        const c = await p.cache();
        const cacheBlock = c.bin ? await p.block(c.bin) : null;
        const matching = c.date != null ? await p.hubRead(c.date) : null;
        const wrong = await p.hubRead(1);
        return {
          cacheBlockInfo: cacheBlock && { comp: cacheBlock.comp, len: cacheBlock.len, head: cacheBlock.head, error: cacheBlock.error, keys: cacheBlock.storage ? Object.keys(cacheBlock.storage) : null },
          cacheDate: c.date ?? null, cacheDateType: typeof c.date, cacheBinType: c.bin ? Object.prototype.toString.call(c.bin) : null,
          cacheMarker: cacheBlock?.storage?.rpf_probe_marker ?? null,
          hubMatching: matching && { status: matching.status, json: matching.json ?? null, marker: matching.block?.storage?.rpf_probe_marker ?? null },
          hubWrong: { status: wrong.status, json: wrong.json ?? null, size: wrong.size ?? null, marker: wrong.block?.storage?.rpf_probe_marker ?? null },
        };
      });
      log(label, v);
      return v;
    };
    const before = await snap('afterSync');

    // A live edit of pluginCustomStorage (TEST account only), the same kind of edit the tool makes.
    const marker = 'm' + Date.now();
    const t0 = Date.now();
    log('pluginStorageObject', await page.evaluate((m) => {
      const db = window.__pluginApis__.getDatabase();
      const existed = !!db.pluginCustomStorage && typeof db.pluginCustomStorage === 'object';
      if (!existed) db.pluginCustomStorage = {};
      db.pluginCustomStorage.rpf_probe_marker = m;
      return { existed, nowObject: typeof db.pluginCustomStorage === 'object' };
    }, marker));
    const firstChange = await until('CACHE_DATE_CHANGE', async () => {
      const d = await page.evaluate(async () => (await window.__rpfProbe.cache()).date);
      return d !== before.cacheDate ? { ms: Date.now() - t0 } : false;
    }, 180000, 500);
    log('cacheDateChanged', firstChange);
    await delay(500);
    const after = await snap('afterEdit');
    log('verdict', { markerInCache: after.cacheMarker === marker, markerOnHubViaWrongDate: after.hubWrong.marker === marker,
      matchingDateAnswer: after.hubMatching?.status ?? null });

    // Clean the marker back out (TEST account).
    await page.evaluate(() => { delete window.__pluginApis__.getDatabase().pluginCustomStorage.rpf_probe_marker; });
    await until('CLEANUP_SAVED', async () => {
      const v = await page.evaluate(async () => { const p = window.__rpfProbe; const c = await p.cache(); return c.bin ? (await p.block(c.bin)).storage : null; });
      return v && !('rpf_probe_marker' in v);
    }, 180000, 1000);
    log('cleaned', { ok: true });
    R.complete = true;
    save();
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

run().catch((e) => { R.failure = String(e?.message || e).slice(0, 300); save(); console.error(R.failure); process.exitCode = 1; });
