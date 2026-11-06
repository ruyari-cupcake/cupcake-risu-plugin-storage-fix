// The save receipt's waiting line (src/ui.js rpfWaitingDisplay). The receipt never gives up on its own (0.1.1, R32),
// so this line is the user's only view of a long wait: it names the waited time, adds the other-tab case only while no
// newer save has arrived for a minute, takes it back the moment a save arrives, and never shows an outcome mark.
// It offers no reload (review round 3: a reload mid-save throws the save away, and a button reads as "done").
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rpfWaitingDisplay, rpfAccountStatus, RPF_SLOW_SAVE_NOTICE_MS, RPF_SAVE_STALL_HINT_MS,
  RPF_ACCOUNT_RELOAD_LOGIN, RPF_DEVICE_GATE_TEXT, RPF_DEVICE_GATE_WHY,
  rpfRepairErrorView, RPF_APPLIED_NOTE, RPF_BACKEND_TEXT, RPF_BROWSER_TEXT,
} = require('../src/ui.js');

const OTHER_TAB = '현재 탭이 비활성화되었습니다';

function harness() {
  const status = [];
  let aborted = false;
  const onWaiting = rpfWaitingDisplay({ setStatus: (text) => status.push(text), isAborted: () => aborted });
  return { status, onWaiting, abort: () => { aborted = true; } };
}

test('quiet for the first seconds, then the waited time; never an outcome mark', () => {
  const h = harness();
  h.onWaiting({ waitedMs: RPF_SLOW_SAVE_NOTICE_MS - 1, sinceSaveMs: RPF_SLOW_SAVE_NOTICE_MS - 1 });
  assert.deepEqual(h.status, []);
  h.onWaiting({ waitedMs: 12500, sinceSaveMs: 12500 });
  assert.equal(h.status.length, 1);
  assert.match(h.status[0], /^⏳ 리스 저장을 기다리는 중이에요 \(12초\)\. /);
  assert.ok(!h.status[0].includes(OTHER_TAB));
});

test('the same second is not re-rendered', () => {
  const h = harness();
  h.onWaiting({ waitedMs: 20100, sinceSaveMs: 20100 });
  h.onWaiting({ waitedMs: 20600, sinceSaveMs: 20600 });
  assert.equal(h.status.length, 1);
});

test('a minute without a newer save adds the other-tab case, and a newer save takes it back', () => {
  const h = harness();
  h.onWaiting({ waitedMs: RPF_SAVE_STALL_HINT_MS - 1000, sinceSaveMs: RPF_SAVE_STALL_HINT_MS - 1000 });
  assert.ok(!h.status.at(-1).includes(OTHER_TAB));
  h.onWaiting({ waitedMs: RPF_SAVE_STALL_HINT_MS, sinceSaveMs: RPF_SAVE_STALL_HINT_MS });
  assert.match(h.status.at(-1), /^⏳ 리스 저장을 기다리는 중이에요 \(60초\) — .*그대로 두는 게 좋아요/);
  assert.ok(h.status.at(-1).includes(OTHER_TAB));
  // Waited time is measured from the edit, the stall from the last newer save.
  h.onWaiting({ waitedMs: 95000, sinceSaveMs: 20000 });
  assert.match(h.status.at(-1), /^⏳ 리스 저장을 기다리는 중이에요 \(95초\)\. /);
  assert.ok(!h.status.at(-1).includes(OTHER_TAB));
  h.onWaiting({ waitedMs: 140000, sinceSaveMs: 65000 });
  assert.ok(h.status.at(-1).includes(OTHER_TAB));
});

test('no line ever carries an outcome mark or offers a reload', () => {
  const h = harness();
  for (const [waitedMs, sinceSaveMs] of [[15000, 15000], [70000, 70000], [80000, 0], [200000, 120000]]) {
    h.onWaiting({ waitedMs, sinceSaveMs });
  }
  for (const text of h.status) {
    assert.doesNotMatch(text, /✅|⚠|❌/);
    assert.ok(!text.includes('지금 새로고침'), 'the panel offers no reload while it waits');
  }
});

// Account mode (0.2.0). Stock's Settings → Account shows Logout once an account is set, and Logout turns account saving
// off (unMigrationAccount) — so no account text may send the user there; re-login is stock's own box after a reload.
const ACCOUNT_STATES = [
  { state: 'healthy', backend: 'account', pointer: 'p', keyCount: 3 },
  { state: 'local-only', backend: 'account', pointer: 'p', keyCount: 3 },
  { state: 'account-login', backend: 'account' },
  { state: 'account-auth-unknown', backend: 'account' },
  { state: 'account-mismatch', backend: 'account' },
  { state: 'account-unavailable', backend: 'account', status: 503, phase: 'scan' },
  { state: 'account-unavailable', backend: 'account', status: null, phase: 'db' },
  { state: 'account-not-settled', backend: 'account', pointer: 'p' },
];

test('every account-only state has a panel line; none points at Settings, Account or Logout', () => {
  const texts = [RPF_ACCOUNT_RELOAD_LOGIN, RPF_DEVICE_GATE_TEXT, RPF_DEVICE_GATE_WHY];
  for (const result of ACCOUNT_STATES) {
    const view = rpfAccountStatus(result);
    assert.ok(view, `no panel line for ${result.state}`);
    assert.ok(view.text.length > 0);
    for (const name of view.buttons) assert.ok(['reload', 'rerun'].includes(name), `${result.state}: unknown button ${name}`);
    texts.push(view.text);
  }
  for (const text of texts) {
    assert.doesNotMatch(text, /설정|로그아웃|Logout|Settings|Account/, text);
  }
});

test('states that change nothing say so, and only healthy carries ✅', () => {
  for (const result of ACCOUNT_STATES) {
    const { text } = rpfAccountStatus(result);
    if (result.state === 'healthy') assert.match(text, /^✅/);
    else assert.doesNotMatch(text, /✅/);
    if (result.state !== 'healthy') assert.match(text, /바꾸지 않았어요|바꾸지 않아요/, result.state);
  }
  assert.match(rpfAccountStatus(ACCOUNT_STATES[5]).text, /응답 503/);
  assert.doesNotMatch(rpfAccountStatus(ACCOUNT_STATES[6]).text, /응답/);
});

test('web and shared states are not account lines', () => {
  for (const state of ['broken', 'uncertain', 'no-index', 'not-risu']) {
    assert.equal(rpfAccountStatus({ state, backend: 'account' }), null, state);
  }
});

test('account waiting line names other devices, and a refusing server is said outright', () => {
  const status = [];
  const onWaiting = rpfWaitingDisplay({ setStatus: (text) => status.push(text), isAborted: () => false, account: true });
  onWaiting({ waitedMs: RPF_SAVE_STALL_HINT_MS, sinceSaveMs: RPF_SAVE_STALL_HINT_MS, hubRejecting: false });
  assert.ok(status.at(-1).includes('다른 탭이나 다른 기기가'));
  assert.ok(status.at(-1).includes(OTHER_TAB));
  onWaiting({ waitedMs: RPF_SAVE_STALL_HINT_MS + 5000, sinceSaveMs: 1000, hubRejecting: true });
  assert.match(status.at(-1), /계정 서버가 저장을 받지 않는 상태예요/);
  assert.doesNotMatch(status.at(-1), /✅|⚠|❌/);
  // Web mode never mentions devices, even if a hubRejecting flag slipped through.
  const web = [];
  const webWaiting = rpfWaitingDisplay({ setStatus: (text) => web.push(text), isAborted: () => false });
  webWaiting({ waitedMs: RPF_SAVE_STALL_HINT_MS, sinceSaveMs: RPF_SAVE_STALL_HINT_MS, hubRejecting: true });
  assert.ok(!web.at(-1).includes('기기'));
  assert.ok(web.at(-1).includes('다른 탭이 저장을'));
});

test('nothing is rendered after the panel was closed (aborted)', () => {
  const h = harness();
  h.onWaiting({ waitedMs: 30000, sinceSaveMs: 30000 });
  h.abort();
  h.onWaiting({ waitedMs: 90000, sinceSaveMs: 90000 });
  assert.equal(h.status.length, 1);
});

// Review fix O2 (0.2.0): an error after the live edit (core `applied: true`) must say the tab already holds the change and
// the save is unconfirmed — never "nothing changed" (several core messages say 변경하지 않았어요), never ✅, never Settings.
const NO_CHANGE = /변경하지 않았어요|바꾸지 않았어요|바꾸지 않아요/;
const coreLike = (code, message, applied) => Object.assign(new Error(message), { name: 'FixError', code, ...(applied ? { applied: true } : {}) });

test('an applied repair error says the change is in the tab and unconfirmed, whatever its code and message', () => {
  for (const code of ['ACCOUNT_LOGIN', 'ACCOUNT_MISMATCH', 'CHANGED', 'UNCERTAIN', 'NOT_SETTLED', 'SOMETHING_NEW']) {
    const view = rpfRepairErrorView(coreLike(code, '확실하게 읽을 수 없어서 변경하지 않았어요.', true), true, 'fallback');
    assert.ok(view.text.includes(RPF_APPLIED_NOTE), code);
    assert.doesNotMatch(view.text, NO_CHANGE, code);
    assert.doesNotMatch(view.text, /✅|설정|로그아웃|Logout|Settings|Account/, code);
    assert.deepEqual(view.buttons, ['reload', 'rerun'], code);
  }
  const login = rpfRepairErrorView(coreLike('ACCOUNT_LOGIN', 'x', true), true, 'fallback');
  assert.ok(login.text.includes(RPF_ACCOUNT_RELOAD_LOGIN));
  const gone = rpfRepairErrorView(coreLike('TARGET_GONE', '되살릴 목차가 더는 서버에서 읽히지 않아요. 변경을 반복하지 않았어요.', true), true, 'fallback');
  assert.match(gone.text, /^⚠ 되살릴 목차가/);
  assert.ok(gone.text.includes(RPF_APPLIED_NOTE));
  // Core also marks an UNEXPECTED error (plain Error from an adapter) that escapes after the edit (Astra delta review).
  const plain = Object.assign(new Error('adapter broke'), { applied: true });
  const unexpected = rpfRepairErrorView(plain, false, '예상하지 못한 오류가 났어요: adapter broke');
  assert.match(unexpected.text, /^⚠ 예상하지 못한 오류가 났어요: adapter broke\n/);
  assert.ok(unexpected.text.includes(RPF_APPLIED_NOTE));
  assert.deepEqual(unexpected.buttons, ['reload', 'rerun']);
});

test('a repair error before the edit never claims the change is in the tab', () => {
  const cases = [
    [coreLike('NOT_SETTLED', '일치하지 않아 변경하지 않았어요.'), true, ['reload', 'rerun'], /^⚠ 일치하지 않아/],
    [coreLike('UNCERTAIN', '읽을 수 없어서 변경하지 않았어요.'), true, ['reload', 'rerun'], /^⚠ 읽을 수 없어서/],
    [coreLike('TARGET_GONE', '읽히지 않아요.'), true, ['reload', 'rerun'], /남아 있는 다른 시점/],
    [coreLike('ACCOUNT_LOGIN', '로그인 확인 못함'), true, ['reload', 'rerun'], /^❌ 로그인 확인 못함/],
    [coreLike('DEVICES_NOT_CONFIRMED', 'x'), true, ['rerun'], /^❌ fallback$/],
    [new Error('plain'), false, ['rerun'], /^❌ fallback$/],
    [Object.assign(new Error('plain'), { applied: false }), false, ['rerun'], /^❌ fallback$/],
  ];
  for (const [error, isFixError, buttons, pattern] of cases) {
    const view = rpfRepairErrorView(error, isFixError, 'fallback');
    assert.ok(!view.text.includes(RPF_APPLIED_NOTE), error.code);
    assert.deepEqual(view.buttons, buttons, error.code);
    assert.match(view.text, pattern, error.code);
  }
});

test('refusal texts: no-fetch has its own line, self-hosted names account sync too', () => {
  assert.match(RPF_BROWSER_TEXT.fetch, /fetch/);
  assert.doesNotMatch(RPF_BROWSER_TEXT.fetch, /OPFS|http:\/\//);
  assert.match(RPF_BACKEND_TEXT.node, /계정 저장을 켜 둔 경우도/);
  assert.doesNotMatch(RPF_BACKEND_TEXT.node, /파일이 서버에 있어서/);
});
