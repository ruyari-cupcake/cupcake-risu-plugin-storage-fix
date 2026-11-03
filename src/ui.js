// On-page panel for the plugin storage fix. Concatenated after core.js by scripts/build.cjs, so
// `RisuPluginStorageFix` is in scope. Everything renders inside a shadow root so Risu styles
// cannot leak in, and running the bookmarklet again replaces the previous panel.
// Dynamic text (plugin key names come from plugin-controlled storage) is only ever set through
// textContent, never interpolated into innerHTML.
const RPF_VERSION = '__RPF_VERSION__';
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
  account: [
    'Risu 계정 저장 모드에서는 플러그인 저장소가 계정 서버에 있어요.',
    '서버가 잠깐 응답하지 않을 때도 똑같은 오류가 나기 때문에, 이 도구는 계정 모드에서는 아무것도 바꾸지 않아요.',
    '새로고침을 몇 번 해 보고, 시간이 지나도 계속되면 리스 개발자에게 알려 주세요.',
  ].join('\n'),
  node: [
    '자체 서버(노드) 리스에서는 플러그인 저장소 파일이 서버에 있어서 이 도구가 확인할 수 없어요.',
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
};

const RPF_ACCOUNT_HINT = '이 브라우저에서 Risu 계정 저장을 쓰다가 로그아웃했거나 동기화를 끈 흔적이 있어요. '
  + '그렇다면 최신 플러그인 데이터는 계정 쪽에 남아 있을 수 있어요 (이 도구는 계정 쪽을 확인할 수 없어요). '
  + '이 도구로 무언가를 바꾸기 전에, 설정의 Risu 계정에서 다시 로그인해 계정 데이터를 불러오는 것부터 해 보세요.';

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
function rpfWaitingDisplay({ setStatus, isAborted }) {
  let shownText = '';
  return ({ waitedMs, sinceSaveMs }) => {
    if (isAborted() || waitedMs < RPF_SLOW_SAVE_NOTICE_MS) return;
    const waited = Math.floor(waitedMs / 1000);
    const text = sinceSaveMs >= RPF_SAVE_STALL_HINT_MS
      ? `⏳ 리스 저장을 기다리는 중이에요 (${waited}초) — 큰 저장 파일은 한 번 저장하는 데 몇 분 걸리기도 해서, 그대로 두는 게 좋아요.\n`
        + '리스가 "현재 탭이 비활성화되었습니다" 안내를 띄웠다면 이 탭은 저장을 멈춘 상태예요. 그 안내의 OK를 누르면 새로고침되니, '
        + '그다음 이 도구를 다시 실행해 주세요 (아직 저장되지 않았다면 고장으로 나오니 한 번 더 고치면 돼요).'
      : `⏳ 리스 저장을 기다리는 중이에요 (${waited}초). 데이터베이스가 크거나 기기가 느리면 몇 분 걸리기도 해요 — `
        + '그대로 두면 저장이 끝나는 대로 완료 표시가 떠요.\n그만 기다리려면 닫기(×)를 누르세요 (바꾼 표시는 그대로예요).';
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
      <p class="note">이 도구가 직접 바꾸는 건 리스 데이터베이스 안의 플러그인 저장소 목차 표시 하나뿐이에요. 아무것도 인터넷으로 보내지 않아요.</p>
    </div>`;
  document.body.appendChild(host);

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
  const env = RisuPluginStorageFix.createBrowserEnv(window);
  // AbortController of the in-flight diagnose / repair, if any.
  let running = null;
  let disposed = false;
  let diagnosis = null;

  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.className = `status ${tone}`;
  };
  const showButtons = (visible) => {
    for (const button of [recoverButton, resetButton, reloadButton, rerunButton]) {
      button.hidden = !visible.includes(button);
      button.disabled = false;
    }
    mainActions.hidden = visible.length === 0;
  };
  const closeConfirm = () => {
    confirmBox.hidden = true;
    agree.checked = false;
    doReset.disabled = true;
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
    if (result.accountHint) addAccountHint();
    if (candidates.length === 0) {
      detail.appendChild(rpfParagraph('살아 있는 예전 목차는 찾지 못했어요. 이 목차에 있던 값들은 이 기기에서 이미 읽을 수 없는 상태예요.'
        + ' 초기화하면 없는 목차를 가리키는 표시만 지우고, 플러그인 저장소가 새로 시작해요.'));
    } else {
      detail.appendChild(rpfParagraph(`살아 있는 예전 목차(플러그인 데이터를 저장해 둔 시점)를 ${candidates.length}개 찾았어요. `
        + '하나를 고르면 그 시점의 플러그인 데이터로 돌아가요 (맨 위가 가장 최근).'));
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
        title.textContent = `${rpfFormatTime(candidate.lastModified)} · 값 ${candidate.keyCount}개`;
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
          missing.textContent = `큰 값 ${candidate.largeCount}개 중 ${candidate.missingLarge}개는 파일이 없어서 빈 값으로 읽혀요. `
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
    items.push(diagnosis && diagnosis.accountHint
      ? RPF_ACCOUNT_HINT
      : '최근에 Risu 계정 로그아웃이나 "계정에 저장" 끄기를 했다면, 목차가 계정 쪽에 남아 있을 수도 있어요 (이 도구로는 확인할 수 없어요). 그렇다면 그쪽부터 확인해 보세요.');
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
      setStatus('✅ 플러그인 저장소는 정상이에요 (아직 저장된 값이 없어요). 고칠 게 없어요.', 'ok');
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
    const why = result.reason === 'unreadable'
      ? '플러그인 저장소 목차 파일이 손상돼서 읽을 수 없어요.'
      : '플러그인 저장소 목차 파일이 이 브라우저에 없어요.';
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
    const run = new AbortController();
    running = run;
    showButtons([]);
    closeConfirm();
    setStatus('바꾸는 중… 리스가 저장을 마칠 때까지 기다려요 (보통 몇 초). 창을 닫지 마세요.');
    const onWaiting = rpfWaitingDisplay({ setStatus, isAborted: () => run.signal.aborted });
    try {
      if (action === 'recover') {
        await RisuPluginStorageFix.recover(env, { pointer: diagnosis.pointer, candidateId, signal: run.signal, onWaiting });
      } else {
        await RisuPluginStorageFix.reset(env, { pointer: diagnosis.pointer, signal: run.signal, onWaiting });
      }
      if (run.signal.aborted) return;
      detail.textContent = '';
      const reloadHint = '\n이 도구가 바꾼 표시는 저장까지 끝났어요. 방금 플러그인을 쓰던 중이었다면 몇 초 뒤에 새로고침해 주세요 '
        + '(플러그인이 따로 저장 중인 값까지는 이 도구가 확인할 수 없어요).'
        + '\n브라우저가 "사이트에서 나가시겠습니까?"라고 물으면 새로고침(나가기)을 눌러 주세요.';
      setStatus((action === 'recover'
        ? '✅ 고른 시점의 목차로 되돌리고, 리스 저장 파일에 반영된 것까지 확인했어요.\n"지금 새로고침"을 누르면 플러그인들이 되살린 데이터로 다시 시작해요.'
        : '✅ 없는 목차 표시를 지우고, 리스 저장 파일에 반영된 것까지 확인했어요.\n"지금 새로고침"을 누르면 플러그인 저장소가 새로 시작해요.') + reloadHint, 'ok');
      showButtons([reloadButton]);
    } catch (error) {
      if (run.signal.aborted) return;
      if (error instanceof RisuPluginStorageFix.FixError && (error.code === 'NOT_SETTLED' || error.code === 'UNCERTAIN')) {
        setStatus(`⚠ ${error.message}\n"지금 새로고침"을 누른 뒤 이 도구를 다시 실행해 주세요. "다시 확인"만 누르면 같은 상태로 다시 확인하게 돼요.`, 'error');
        showButtons([reloadButton, rerunButton]);
        return;
      }
      setStatus(`❌ ${rpfErrorText(error)}`, 'error');
      showButtons([rerunButton]);
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
    doReset.disabled = true;
  });
  agree.addEventListener('change', () => {
    doReset.disabled = !agree.checked;
  });
  root.querySelector('.cancel-reset').addEventListener('click', closeConfirm);
  doReset.addEventListener('click', () => {
    if (agree.checked) runRepair('reset');
  });
  reloadButton.addEventListener('click', () => location.reload());

  runDiagnose();
}

if (typeof module !== 'undefined') module.exports = { rpfWaitingDisplay, RPF_SLOW_SAVE_NOTICE_MS, RPF_SAVE_STALL_HINT_MS }; // @strip-in-bundle
