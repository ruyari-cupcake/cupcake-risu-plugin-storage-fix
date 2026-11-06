// Account-mode helpers for drive.mjs (Risu account sync on the stock hub). TEST account only: the credentials file
// (RPF_ACCOUNT_ENV, default ~/.config/cpm-secrets/risu-test-account.env, keys RISU_TEST_ID / RISU_TEST_PASSWORD) must hold a
// throwaway account — the harness empties its cold storage and overwrites its synced database on every run.
// The oracle reads the hub itself (stock request shapes from v2026.10.294 accountStorage.ts / coldstorage.svelte.ts) and
// shares no code with the tool. Nothing here prints a token or password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HUB = 'https://sv.risuai.xyz';
const DB_KEY = 'database/database.bin';

export function accountCredentials() {
  const file = process.env.RPF_ACCOUNT_ENV || path.join(os.homedir(), '.config/cpm-secrets/risu-test-account.env');
  const env = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')]; }));
  if (!env.RISU_TEST_ID || !env.RISU_TEST_PASSWORD) throw new Error('ACCOUNT_ENV_MISSING');
  return { id: env.RISU_TEST_ID, password: env.RISU_TEST_PASSWORD };
}

// Node-side hub session for harness setup only (the same GET login form the hub page uses).
export async function hubSession() {
  const { id, password } = accountCredentials();
  const res = await fetch(`${HUB}/hub/login?${new URLSearchParams({ id, password })}`, { headers: { 'User-Agent': 'Mozilla/5.0 (rpf live harness)' } });
  const match = /"token":"([0-9a-f-]+)"/.exec(await res.text());
  if (!match) throw new Error('HUB_LOGIN_FAILED');
  const auth = { 'x-risu-auth': match[1], 'User-Agent': 'Mozilla/5.0 (rpf live harness)' };
  const call = (method, headers, body) => fetch(`${HUB}/hub/account/coldstorage`, { method, headers: { ...auth, ...headers }, body });
  return {
    async list() {
      const r = await call('GET', { 'x-risu-key': '@list-keys' });
      if (r.status !== 200) throw new Error(`HUB_LIST_${r.status}`);
      return (await r.json()).items;
    },
    async get(key) {
      const r = await call('GET', { 'x-risu-key': key });
      return { status: r.status, bytes: r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null };
    },
    // Stock removeColdStorageItems request shape (coldstorage.svelte.ts:271-290).
    async remove(keys) {
      if (keys.length === 0) return;
      const r = await call('POST', { 'x-risu-key': 'remove', 'x-action': 'remove' }, JSON.stringify({ keys }));
      if (r.status !== 200) throw new Error(`HUB_REMOVE_${r.status}`);
    },
  };
}

export async function emptyHubColdStorage() {
  const hub = await hubSession();
  const keys = await hub.list();
  await hub.remove(keys);
  const left = await hub.list();
  if (left.length) throw new Error('HUB_NOT_EMPTIED');
  return keys.length;
}

// Settings → Account → Login (hub iframe) → "Save Data in Account" → stock reloads and asks load/save; `choice` picks one,
// the upload path also asks to type RISUAI. Ends in account mode (accountst = able) with the host booted again.
export async function loginAndSync(page, { choice, boot, until, sleep }) {
  const { id, password } = accountCredentials();
  let gear = page.locator('button:has(svg.lucide-settings)').filter({ visible: true });
  if (!await gear.count()) {
    await page.locator('button:has(svg.lucide-list)').filter({ visible: true }).first().click();
    await sleep(800);
    gear = page.locator('button:has(svg.lucide-settings)').filter({ visible: true });
  }
  await gear.first().click();
  await sleep(1500);
  await page.locator('.rs-setting-cont button, .rs-setting-cont-3 button').filter({ hasText: /^\s*Account/ }).first().click();
  await sleep(1500);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const frame = page.frameLocator('iframe[title="login"]');
  await frame.locator('#id').fill(id);
  await frame.locator('#password').fill(password);
  await frame.locator('button[type="submit"]').click();
  await until('ACCOUNT_LOGIN_TIMEOUT', async () => (await page.locator('body').innerText()).includes(`ID: ${id}`));
  // The sync checkbox reloads the page at once; the login lives only in memory until stock's next save writes the local
  // database (IndexedDB `risuai`, uncompressed root block outside account mode). Reloading before that loses the login.
  await until('ACCOUNT_LOGIN_NOT_SAVED', () => page.evaluate(async (accountId) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('risuai'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      if (!db.objectStoreNames.contains('keyvaluepairs')) return false;
      const bytes = await new Promise((resolve, reject) => {
        const q = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get('database/database.bin');
        q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
      });
      if (!bytes) return false;
      return new TextDecoder('latin1').decode(bytes).includes(`"id":"${accountId}"`);
    } finally { db.close(); }
  }, id), 60000);
  await page.getByText('Save Data in Account', { exact: true }).first().click();
  const label = choice === 'load' ? 'Load Data from Account' : 'Save Current Data to Account';
  await until('ACCOUNT_SYNC_TIMEOUT', async () => {
    const pick = page.getByRole('button', { name: label, exact: true });
    if (await pick.isVisible().catch(() => false)) { await pick.click(); return false; }
    const body = await page.locator('body').innerText().catch(() => '');
    const input = page.locator('input').filter({ visible: true });
    if (body.includes('type "RISUAI"') && await input.count()) {
      await input.last().fill('RISUAI');
      await page.getByRole('button', { name: 'OK', exact: true }).click();
      return false;
    }
    return (await page.evaluate(() => localStorage.getItem('accountst')).catch(() => null)) === 'able';
  }, 180000);
  await boot(page, null);
}

// Page-side oracle: the hub's CURRENT database (fresh read, save-date 0, unique URL), pluginStorage pointer only.
// Token from the page's own fallback login; never returned.
export async function hubPointer(page) {
  return page.evaluate(async ({ hub, key }) => {
    const token = (() => { try { return JSON.parse(localStorage.getItem('fallbackRisuToken') || 'null')?.token || ''; } catch { return ''; } })();
    const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch(`${hub}/api/account/read/${hex}|${crypto.randomUUID()}`, {
      cache: 'no-store', headers: { 'x-risu-key': key, 'x-risu-save-date': '0', 'x-risu-auth': token },
    });
    if (r.status !== 200) return { status: r.status };
    const u = new Uint8Array(await r.arrayBuffer());
    const magic = [82, 73, 83, 85, 83, 65, 86, 69, 0];
    if (!magic.every((b, i) => u[i] === b)) return { status: 200, format: 'unknown' };
    // A "no pointer" verdict counts only when the pluginStorage block was actually found whole (`hasBlock`): a torn
    // body or a missing block must never read as "the hub holds no pointer".
    let o = 9;
    while (o < u.length) {
      if (o + 3 > u.length) return { status: 200, truncated: true };
      const type = u[o]; const comp = u[o + 1]; const nl = u[o + 2]; o += 3;
      if (o + nl + 4 > u.length) return { status: 200, truncated: true };
      const name = new TextDecoder().decode(u.subarray(o, o + nl)); o += nl;
      const len = new DataView(u.buffer, u.byteOffset + o, 4).getUint32(0, true); o += 4;
      if (o + len > u.length) return { status: 200, truncated: true };
      if (type === 11 && name === 'pluginStorage') {
        let d = u.subarray(o, o + len);
        if (comp === 1) d = new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        const text = new TextDecoder().decode(d);
        const storage = text ? JSON.parse(text) : null;
        return { status: 200, hasBlock: true, pointer: typeof storage?._coldpluginIndex === 'string' ? storage._coldpluginIndex : null };
      }
      o += len;
    }
    return { status: 200, pointer: null, noBlock: true };
  }, { hub: HUB, key: DB_KEY });
}

export async function livePointer(page) {
  return page.evaluate(() => {
    const value = window.__pluginApis__.getDatabase().pluginCustomStorage?._coldpluginIndex;
    return value === undefined ? null : value;
  });
}

// Account counterpart of waitHostSaved: the hub's fresh database pointer equals the live one.
export async function waitHubSaved(page, { until }, ms = 120000) {
  let last = null;
  await until('HUB_SAVE_TIMEOUT', async () => {
    const hub = await hubPointer(page);
    const live = await livePointer(page);
    last = { hub, live };
    return hub.status === 200 && hub.pointer === live;
  }, ms);
  return last;
}

// A routed hub failure for the tool's requests AND stock's (both are page fetches): every coldstorage GET answers `status`.
export async function failHubColdReads(context, status) {
  await context.route(`${HUB}/hub/account/coldstorage`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, body: status === 403 ? 'Bad Login' : 'unavailable' });
  });
}
