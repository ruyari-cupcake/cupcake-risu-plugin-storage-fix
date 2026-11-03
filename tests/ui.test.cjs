// The save receipt's waiting line (src/ui.js rpfWaitingDisplay). The receipt never gives up on its own (0.1.1, R32),
// so this line is the user's only view of a long wait: it names the waited time, adds the other-tab case only while no
// newer save has arrived for a minute, takes it back the moment a save arrives, and never shows an outcome mark.
// It offers no reload (review round 3: a reload mid-save throws the save away, and a button reads as "done").
const test = require('node:test');
const assert = require('node:assert/strict');
const { rpfWaitingDisplay, RPF_SLOW_SAVE_NOTICE_MS, RPF_SAVE_STALL_HINT_MS } = require('../src/ui.js');

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

test('nothing is rendered after the panel was closed (aborted)', () => {
  const h = harness();
  h.onWaiting({ waitedMs: 30000, sinceSaveMs: 30000 });
  h.abort();
  h.onWaiting({ waitedMs: 90000, sinceSaveMs: 90000 });
  assert.equal(h.status.length, 1);
});
