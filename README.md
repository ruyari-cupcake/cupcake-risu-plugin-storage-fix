# 🧁 컵케익 리스 플러그인 저장소 고치기 (cupcake-risu-plugin-storage-fix)

리스(RisuAI) 웹에서 플러그인 저장소가 `Failed to load plugin storage index` 오류로 영영 열리지 않을 때,
**리스 탭 안에서** 상태를 확인하고 고쳐 주는 북마클릿 / 콘솔 스크립트입니다.

**👉 설치 안내: <https://ruyari-cupcake.github.io/cupcake-risu-plugin-storage-fix/>**

## 왜 필요한가

- 리스는 플러그인 저장소(`risuai.pluginStorage`)의 작은 값을 콜드 저장소의 **목차 항목 하나**에 모아 두고,
  데이터베이스에는 그 목차를 가리키는 표시 `pluginCustomStorage._coldpluginIndex`만 둡니다
  (`src/ts/process/pluginStorageStore.ts`).
- 목차를 못 읽으면 리스는 일부러 빈 목차로 바꾸지 않고(다음 저장이 진짜 데이터를 덮어쓸 수 있어서) 모든 요청을
  `Failed to load plugin storage index`로 거부합니다. 이 판단은 **매 부팅** 반복되고, 리스에는 복구 메뉴가 없습니다.
- v3 플러그인은 모두 **같은 저장소 한 칸**을 씁니다(플러그인별 칸이 없음). 그래서 목차가 사라지면 모든 플러그인이
  함께 막히고, 특정 플러그인 몫만 골라 지우는 건 구조상 불가능합니다.
- 목차가 사라지는 경로(소스 판독): Risu 계정 로그아웃 / "계정에 저장" 끄기(계정 콜드 저장소를 로컬로 옮기지 않음,
  upstream [#1690](https://github.com/kwaroran/Risuai/issues/1690)), 콜드 항목 없이 복원된 백업, 브라우저 저장소(OPFS) 정리 등.

## 하는 일

1. **진단** — 목차 파일(`coldstorage_<id>.json`, OPFS)이 정말 없는지/손상됐는지 직접 확인합니다. 정상이면 아무것도 바꾸지 않습니다.
2. **복구 먼저** — 콜드 저장소에서 살아 있는 예전 목차를 찾아(앞부분만 풀어서 형식 확인 → 전체 검증) 최근 순으로 보여 줍니다.
   고르면 표시를 그 목차로 옮깁니다. 오래된 데이터베이스로 복원돼서 최신 목차가 남아 있는 경우 등에 데이터가 통째로 돌아옵니다.
3. **초기화** — 살아 있는 목차가 없거나 사용자가 원하면, 없는 목차를 가리키는 표시 **하나만** 지웁니다(확인 체크 필요).
   다른 키(옛 방식 인라인 값·`_coldplugin`), 콜드 파일, safeLocalStorage, 플러그인 IndexedDB 저장소는 그대로입니다.
4. **저장 확인** — 리스 자동 저장이 `database/database.bin`에 그 변경을 실제로 썼는지, 저장 파일의 `pluginStorage` 블록을
   읽어 확인한 뒤에만 새로고침 버튼을 보여 줍니다(새 `dbbackup-*` 키가 생길 때만 다시 읽음, 최대 1분).

바꾸기 직전에 표시가 진단 때와 같은지, 여전히 고장인지, 고른 목차가 여전히 유효한지 다시 확인합니다.
아무것도 인터넷으로 보내지 않습니다.

### 지원 범위

| 리스 | 동작 |
|---|---|
| 브라우저 웹 리스 (risuai.xyz 계정 저장 미사용, 직접 올린 웹 빌드, 포크) | ✅ 진단·복구·초기화 |
| Risu 계정 저장 모드 (`accountst=able`) | 🚫 확인만 하고 거부 — 허브가 잠깐 오류만 나도 같은 문구가 나서 고장과 구분할 수 없음 |
| 자체 서버(노드) 리스, 데스크톱(Tauri) 앱 | 🚫 거부 — 저장소가 서버/앱 안에 있음 |

유저스크립트는 만들지 않았습니다. 한 번 쓰고 끝나는 수리 도구이고, 리스는 주소가 제각각이라 하나의 `@match`로 정할 수 없습니다.

## 사용법

설치 안내 페이지([온라인](https://ruyari-cupcake.github.io/cupcake-risu-plugin-storage-fix/), `dist/install.html`)에
북마클릿 버튼·짧은 로더 코드·콘솔 스크립트가 모두 있습니다. 빌드 결과물은 `dist/`에 커밋되어 있습니다.

| 형태 | 파일 | 쓰는 법 |
|---|---|---|
| **로더 북마클릿 (모바일 권장, PC도 가능)** | `dist/loader-bookmarklet.txt` (258자) | 북마크 주소로 저장 → 리스 탭에서 실행. GitHub Pages의 `dist/console.js`를 불러옴 (인터넷 필요) |
| 전체 북마클릿 (PC) | `dist/bookmarklet.txt` (약 57 KB) | 북마크바로 끌어다 놓기 → 리스 탭에서 실행. 외부에서 아무것도 불러오지 않음 |
| 콘솔 | `dist/console.js` | 리스 탭의 개발자 도구 콘솔에 붙여넣기 |

실행할 때는 다른 리스 탭을 닫아 주세요. 고친 뒤 **지금 새로고침**을 누르면 되고, risuai.xyz가 "사이트에서 나가시겠습니까?"라고
물으면 새로고침을 누르면 됩니다(저장은 이미 끝난 상태).

## 검증 (2026-11-03, 순정 RisuAI v2026.10.292 = GitHub `ea61945`)

- 단위·번들 테스트 20개 (`npm test`), 뮤테이션 25개 전부 검출 (`npm run mutate`).
- 실기 (`tests/live/drive.mjs`, 헤드리스 크로미움, 순정 정적 웹 빌드):
  - 정상 프로필: "정상" 표시, 표시 그대로. 계정 모드 플래그: 거부, 표시 그대로.
  - 초기화 (IndexedDB DB / OPFS DB 각각, 저장 위치 확인 포함): 고장 재현(`Failed to load plugin storage index`) →
    초기화 → 패널 새로고침 → 죽은 표시가 돌아오지 않음, 옛 인라인 값 보존, 새 값 쓰기가 다음 새로고침까지 유지.
  - 복구: 데이터베이스가 없는 목차를 가리키고 최신 목차는 남은 상태 → 최신 목차가 첫 후보 → 복구 → 새로고침 후 값 그대로.
  - 전체 북마클릿·콘솔·짧은 로더(로컬 번들) 모두 같은 결과.
- **실제 risuai.xyz** (새 프로필, 로그인 없음): 짧은 로더로 초기화 → 새로고침 → 저장소 정상 (보안 정책이 로더를 막지 않음).
- **실제 CPM PROD 1.99.16** (순정 v2026.10.292): 고장 시 CPM의 🗄️ "리스 플러그인 저장소가 열리지 않아요" 안내 →
  도구로 초기화 → 새로고침 후 안내 사라짐, 저장소 읽기 정상, 진단 탭 "Plugin storage (save file): available".

### 확인하지 못한 것

- 실제 Risu 계정 로그아웃으로 생긴 고장(계정 없음 — 같은 상태를 OPFS 파일 삭제로 재현), 계정·노드 모드에서의 수리(일부러 지원 안 함).
- 파이어폭스·사파리·iOS, 실제 폰. 수백 MB 데이터베이스에서 저장 확인에 걸리는 시간(1분 안에 확인 못 하면 안내만 하고 끝남).
- risuai.xyz에서의 복구 시나리오(같은 코드 경로이고 정적 빌드에서 확인).

## 개발

```bash
npm test          # 단위·번들 테스트 (node:test, 의존성 없음)
npm run mutate    # 뮤테이션 검사 — 전부 KILLED여야 함
npm run build     # dist/ 생성
STOCK_DIR=… PLAYWRIGHT_MODULE=… bash tests/live/run-all.sh   # 출시 전 전체 게이트 (tests/live/README.md)
```

- `src/core.js` — DOM 없는 핵심 로직 (진단, 후보 찾기, 복구, 초기화, 저장 파일 확인). Node 테스트와 브라우저가 같은 코드를 씁니다.
- `src/ui.js` — 리스 위에 띄우는 패널 (shadow DOM). 줄 끝 주석 금지: 북마클릿이 줄바꿈을 잃어도 동작해야 합니다 (`tests/bundle.test.cjs`).
- 순정 동작 근거와 계약 → `.report/core-contract.md`, 표시를 읽는 순정 코드 목록 → `.report/caller-map.md`.

## 라이선스

[MIT](LICENSE) © 2026 Ruyari Cupcake
