# omp-activity

OMP 메인 채팅의 도구 호출을 Agent Hub "Recent activity"처럼 한 줄씩 보여주는 플러그인입니다.

```
• 01:25:18 ✓ read  Reading a.txt  · a.txt
• 01:25:20 ✓ grep  Searching for beta  · beta  · 2 matches / 2 files
• 01:25:24 ✓ bash  Checking git status  · git status --short  · 0.1s
✕ 01:25:26 ✗ read  Reading missing file  · missing.txt
• 01:25:28 ✓ edit  Replacing beta with BETA  · a.txt  · +1|1
• 01:25:30 ✓ write Writing new.txt  · new.txt  · +2
• 01:25:32 ✓ git   commit f91a6b2 probe  · 0.1s
[ 8 actions · 1 failed · ↑243K (231K cached) · ↓836 · 19.7s ] — 01:25:34
```

## 설치

OMP 18.18.9 이상이 필요합니다.

```bash
omp plugin marketplace add JSCOP/omp-activity
omp plugin install omp-activity@jscop
```

그다음 OMP를 재시작하고 `/settings → Tools → Extensions → Extension Transcript Presenters`를 켜세요. 꺼져 있으면 시작할 때 경고가 한 번 나옵니다.

## 모드 (`alt+c`로 순환: compact → live → clear → off)

| 모드 | 작업 중 | 답변이 끝난 뒤 |
|---|---|---|
| `compact` | 모든 도구 호출을 한 줄로 | 그대로 전부 남김 |
| `live` (기본) | 모든 도구 호출을 한 줄로 | 파일 변경(edit/write/delete), git 커밋, task만 남기고 read/grep/bash 같은 줄은 숨김 |
| `clear` | git 커밋만 | git 커밋만 |
| `off` | OMP 기본 카드 | OMP 기본 카드 |

- 중단되거나 오류로 끝나 최종 답변이 없으면 `live`도 모든 줄을 남깁니다(원인 확인용).
- `Ctrl+O`로 펼친 블록은 항상 OMP 원래 카드로 보입니다(`Ctrl+O`는 전체를 한꺼번에 펼칩니다).
- 모드를 바꾸면 이미 그려진 줄도 바로 다시 그려집니다.

## 줄 형식

`시각 상태 도구 의도 · 경로/명령 · 부가정보`

- 시각: 도구가 실제로 실행된 시각. `/resume` 후에도 세션 기록의 시각을 씁니다.
- 상태: `✓` 성공, `✗` 실패, `◌` 실행 중
- 부가정보: edit `+추가|삭제`, write `+N new`(새 파일) 또는 `N lines`(덮어쓰기: 실제 변경 줄 수는 계산하지 않음), delete `-줄 수`, bash 실행 시간·종료 코드·`in <cwd>`, grep 일치 수/파일 수, glob 파일 수
- `write xd://` 장치 호출은 파일 변경으로 세지 않고 `mcp`(MCP 도구) 또는 `xd`로 표시하며, 장치 이름은 뒤에 붙입니다(예: `mcp  playwright_browser_tabs`). `read xd://`는 장치 설명서를 읽는 호출이라 그대로 `read`입니다.
- 프로젝트 안의 경로는 상대 경로로 줄입니다(Windows 경로 포함).
- 경로/명령은 터미널 폭에 맞춰 남는 칸만큼 보여주고, 뒤의 부가정보(시간, 일치 수 등)는 잘리지 않게 둡니다. 창 크기를 바꾸면 다시 맞춥니다.

## 한 줄씩 펼치기 (`Alt+E`)

`Alt+E`(또는 `/activity open`)를 누르면 지금 화면의 도구 줄 목록(최근 순)이 열립니다. 하나를 고르면 그 줄만 OMP 원래 카드로 펼쳐지고, 같은 줄을 다시 고르면 한 줄로 접힙니다. 펼친 줄이 있으면 목록 맨 위의 "모두 접기"로 한꺼번에 접을 수 있습니다. 메인 화면과 서브에이전트 화면 모두 됩니다.

OMP는 일반 터미널에서 도구 줄 안의 링크를 그리지 않아서, 줄을 마우스로 클릭해 펼치는 방식은 지원하지 않습니다.

## 실행 통계 줄

답변 아래에 한 줄: 도구 호출 수, 실패 수, 보낸 토큰(캐시 포함), 받은 토큰, 걸린 시간, 끝난 시각. 실패가 있으면 경고색입니다. 화면에만 보이고 모델 컨텍스트에는 들어가지 않습니다.

## 서브에이전트 화면 (`Alt+A` → 선택)

OMP는 서브에이전트 화면에서 플러그인 표시를 끄고 기본 카드로 그립니다. 이 플러그인은 그 화면을 열 때 OMP가 지운 표시 플러그인 목록을 다시 넣어서, 서브에이전트의 도구 호출도 같은 한 줄로 보이게 합니다. OMP 파일은 건드리지 않고 실행 중에만 적용되므로 OMP를 업데이트해도 그대로 동작합니다.

- 시각: 서브에이전트 세션 기록의 시각, 화면을 보는 중에 새로 생긴 호출은 처음 그린 시각
- `live` 모드여도 서브에이전트 화면은 모든 줄을 남깁니다(서브에이전트 실행이 끝났는지 이 화면에서는 알 수 없음). `clear`는 커밋만 남깁니다.
- 끄려면 `/activity subagentView off` (다음에 서브에이전트 화면을 열 때부터 적용)
- OMP 내부 메서드(`InteractiveMode.renderInitialMessages`)를 감싸는 방식이라, OMP가 이 구조를 바꾸면 서브에이전트 화면만 다시 기본 카드로 돌아갑니다. 메인 화면은 영향이 없습니다.
- `display.hideToolActivity`가 켜져 있으면 서브에이전트 화면에서도 도구 줄이 숨겨집니다.

## 설정 (`/activity`)

`/activity`를 입력하면 메뉴가 열립니다. 직접 지정도 됩니다.

```
/activity mode live
/activity showTime off
/activity showIntent off      # 의도 대신 경로/명령을 메인으로
/activity showArgs off        # 의도 뒤 경로/명령 숨김
/activity stats off
/activity compactPaths off
/activity compactAdvisor on   # advisor nit/concern을 한 줄로
/activity subagentView off    # 서브에이전트 화면은 OMP 기본 카드로
/activity tool bash open      # rows | newest | open | hide
```

도구별 표시 기본값: `ask`는 `open`(항상 카드), `wait`/`todo`는 `newest`(작업 중 최신 호출만 카드), 나머지는 `rows`.

설정은 `~/.omp/agent/omp-activity.json`에 저장되고, 실행 중인 모든 세션이 1초 안에 같은 설정을 따릅니다. 단축키(`cycleKey`)만은 바꾼 뒤 재시작해야 합니다.

## 제거

```bash
omp plugin uninstall omp-activity@jscop
```
