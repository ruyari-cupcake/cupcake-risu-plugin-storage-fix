// Design probe, not a release step (TEST account, read-only GETs; `node tests/live/account-save-date-probe.mjs`): how does
// the hub answer a database read whose x-risu-save-date is NEWER than the date it holds? Stock's getItem sends the cached
// __date, which stock writes even for a save the hub refused. Measured 2026-11-06: 0, 1 and a year-old date → 200 with the
// body; now, +1 min and +1 year → 303 {"match":true} — so after a refused save stock reloads its refused local copy.
// Prints statuses and the 303 bodies only; never prints the token.
import { accountCredentials } from './account-live.mjs';

const HUB = 'https://sv.risuai.xyz';
const KEY = 'database/database.bin';
const hex = Buffer.from(KEY, 'utf8').toString('hex');
const { id, password } = accountCredentials();
const login = await fetch(`${HUB}/hub/login?${new URLSearchParams({ id, password })}`, { headers: { 'User-Agent': 'Mozilla/5.0 (rpf live harness)' } });
const token = /"token":"([0-9a-f-]+)"/.exec(await login.text())?.[1];
if (!token) throw new Error('HUB_LOGIN_FAILED');
async function read(saveDate) {
  const r = await fetch(`${HUB}/api/account/read/${hex}|${crypto.randomUUID()}`, {
    cache: 'no-store', redirect: 'manual',
    headers: { 'x-risu-auth': token, 'x-risu-key': KEY, 'x-risu-save-date': String(saveDate), 'User-Agent': 'Mozilla/5.0 (rpf live harness)' },
  });
  const body = r.status === 303 ? await r.text() : (await r.arrayBuffer(), '');
  return { saveDate: String(saveDate).length > 6 ? `${String(saveDate).slice(0, 4)}…` : saveDate, status: r.status, body: body.slice(0, 80) };
}
const now = Date.now();
for (const date of [0, 1, now - 365 * 86400000, now, now + 60000, now + 365 * 86400000]) console.log(JSON.stringify(await read(date)));
