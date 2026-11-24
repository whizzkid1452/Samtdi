# 사맛디 Figma 화면 대조

Figma 원본의 `00 · 기능 목록`과 `01 · 제품 화면`을 열었다. 설치된 앱의 읽기 전용 파일 확인에서 프로토타입 프레임 103개와 누락 0개를 확인했다. 아래 표는 설계 인벤토리 199개와 별도 프로토타입 기록 104개를 화면 키로 합친 223개 항목이다. 탐색 인덱스 1개와 유료화 보류 시안을 포함한다. 중복 화면 키는 한 번만 적었고, 프레임 ID가 기록된 행은 개별 프레임, 나머지는 해당 보드로 연결했다. [Figma 스펙 대조표](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=80-2)

| 판정 | 화면 수 | 근거 |
| --- | ---: | --- |
| 실행 확인 | 36 | 실제 UI나 API로 해당 상태를 확인 |
| 코드 대조 | 142 | 해당 경로와 코드의 화면 상태를 대조. 개별 시나리오 실기 검증은 남아 있음 |
| 화면 차이 | 22 | 디자인 시안과 현재 UI 구성 또는 동작의 차이를 표에 기록 |
| 조건부 | 10 | 외부 인증 설정, 커밋 데이터 또는 별도 실행이 필요 |
| 보류 | 13 | 결제·구독과 사용량 제어 |

Chrome은 1320 × 900과 390 × 844에서 실행했다. PostgreSQL과 VersityGW를 격리해 실제 7초 스테레오 WAV의 신규·수정본 게시, 같은 렌더 재시도의 버전 수, 재생과 SHA-256을 확인했다. OAuth 세션을 발급해 QA 앱에 주입했고, 일반 배포 빌드의 macOS 키체인 승인 대기는 이 검증과 별개다. 프레임별 픽셀 동일성과 운영 환경의 이메일 발송은 판정 범위 밖이다.

## 프로젝트와 로그인

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [사맛디 로그인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-3) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [계정 인증](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-64) | 조건부 | 계정 인증 화면은 Logto 설정에 위임한다. 운영 인증 메일의 화면·발송은 미검증. |
| [프로젝트 초대 수락](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=20-2) | 코드 대조 | project-screen.tsx · workspace.tsx |
| [만료된 초대](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=20-2) | 코드 대조 | project-screen.tsx · workspace.tsx |
| [세션 조회 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=20-2) | 코드 대조 | project-screen.tsx · workspace.tsx |
| [모바일 로그인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=20-2) | 화면 차이 | Chrome에서 링크·레이아웃을 확인. 공통 로그인 CSS의 한 열 레이아웃을 사용한다. |
| [프로젝트 홈](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-128) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [프로젝트 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=20-2) | 코드 대조 | project-screen.tsx · workspace.tsx |

## 작업공간

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [프로젝트가 없는 작업공간](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [프로젝트 검색 결과 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [보관 프로젝트 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [작업공간 전환](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-8490) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [새 작업공간 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-8798) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [팀 작업공간 멤버](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [작업공간 만들기 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9106) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [프로젝트 접근 불가](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [삭제된 항목 링크](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |
| [작업공간 조회 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=23-2) | 코드 대조 | workspace-manager.tsx · workspace.tsx |

## 활동·알림

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [내 작업 · 내 담당](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4483) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [내 작업 · 검토 대기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4612) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [내 작업 · 7일 내 마감](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4719) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [내 작업 · 지연 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4837) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [알림 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4933) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [읽은 알림](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-5184) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [받은 알림 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-5435) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [프로젝트 활동](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-5660) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [피드백 활동 필터](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-5808) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [활동 검색 결과 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-5925) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [활동 조회 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20794) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [음원 활동 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20320) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [활동 유형 메뉴](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17374) | 화면 차이 | 웹에서 네이티브 선택 입력을 사용한다. |
| [프로젝트 활동 · 모바일](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-16570) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [이전 활동](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17526) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [프로젝트 활동 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20636) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [작업 활동 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20478) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [모두 읽음 처리](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-16884) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [알림 조회 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17145) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [이전 알림](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-16620) | 코드 대조 | workspace-activity.tsx · notifications.tsx |
| [알림 조회 오류 · 모바일](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-21000) | 화면 차이 | 모바일 팝오버의 공통 오류·재시도 행으로 표시한다. |
| [읽은 알림 · 모바일](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20949) | 화면 차이 | 모바일에서도 같은 팝오버로 읽음 상태를 확인한다. |
| [알림 · 모바일](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-16522) | 화면 차이 | 좁은 화면에서도 상단의 반응형 팝오버를 사용한다. 독립 수신함 페이지 구성과 다르다. |

## 프로젝트 설정

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [프로젝트 설정 · 소유자](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=115-3) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [프로젝트 설정 · 검토자](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 화면 차이 | 프로젝트 설정의 제어는 소유자에게만 보이며 검토자는 권한 범위 안에서 접근한다. |
| [프로젝트 팀원 초대](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |
| [발급한 초대 링크](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |
| [초대 취소](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |
| [멤버 역할 변경](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |
| [프로젝트 멤버 제거](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |
| [프로젝트 작업공간 연결](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=24-2) | 코드 대조 | project-screen.tsx · project-members.tsx |

## 계정과 보관

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [계정 메뉴](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=25-2) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [오픈소스 고지](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=25-2) | 코드 대조 | account-profile.tsx · workspace.tsx · project-screen.tsx |
| [프로젝트 보관 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=25-2) | 코드 대조 | account-profile.tsx · workspace.tsx · project-screen.tsx |
| [보관된 프로젝트 설정](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=25-2) | 코드 대조 | account-profile.tsx · workspace.tsx · project-screen.tsx |
| [프로젝트 복원 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=25-2) | 코드 대조 | account-profile.tsx · workspace.tsx · project-screen.tsx |

## 작업 목록과 보드

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [작업 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=108-2003) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [작업 보드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=108-3) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [보드에서 작업 이동](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=31-2) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [작업 카드 메뉴](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=108-398) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [작업 검색 결과 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=31-2) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [작업 조회 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=31-2) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [보관한 작업](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=31-2) | 코드 대조 | task-board.tsx · task-drag.tsx |
| [검토자 작업 보드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=31-2) | 코드 대조 | task-board.tsx · task-drag.tsx |

## 작업 상세와 편집

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [작업 상세](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-4045) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [새 작업 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=32-2) | 코드 대조 | task-board.tsx · task-editor.tsx · task-option-picker.tsx |
| [작업 수정](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=32-2) | 코드 대조 | task-board.tsx · task-editor.tsx · task-option-picker.tsx |
| [피드백에서 작업 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-3289) | 코드 대조 | task-board.tsx · task-editor.tsx · task-option-picker.tsx |
| [기존 피드백 연결](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=32-2) | 코드 대조 | task-board.tsx · task-editor.tsx · task-option-picker.tsx |
| [작업 초안 복원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=32-2) | 화면 차이 | 작업 입력을 세션 저장소에 보존하고 편집 폼에 복원한다. |
| [작업에 연결된 피드백](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-2581) | 코드 대조 | task-board.tsx · task-editor.tsx · task-option-picker.tsx |

## 작업 검토와 완료

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [검토 요청](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [결과 버전 선택](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [검토 대기 작업](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=108-1821) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [완료 전 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=108-2503) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [완료된 작업](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [동시 수정 충돌](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [작업 보관](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |
| [보관된 작업 복원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=29-2) | 코드 대조 | task-editor.tsx · web_tasks.go |

## 커밋 리뷰

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [참여 프로젝트](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=26-2) | 코드 대조 | review_web.go · Ayotbi ReviewListPanel.cpp |
| [제품 PR 목록과 생성](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=26-2) | 조건부 | 기존 데스크톱 소스 제어의 제품 PR 흐름이다. 실행 상태는 이번 게시 테스트에서 다루지 않았다. |
| [커밋 리뷰와 WAV 비교](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-8305) | 조건부 | 사맛디 웹 출처에서 기존 커밋 리뷰 경로를 확인했다. 선택적 커밋과 리뷰 ID를 포함한 게시 시나리오는 미검증. |
| [WAV 렌더 요청 중](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=26-2) | 조건부 | 기존 커밋 리뷰 렌더 작업이다. 이번 배치의 게시 테스트는 로컬 어엿비 믹스 렌더다. |
| [WAV 렌더 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=26-2) | 조건부 | 기존 커밋 리뷰 렌더의 실패 화면이다. 이번 테스트에서는 강제로 실패시키지 않았다. |
| [병합 후보 검증](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=26-2) | 조건부 | 기존 리뷰의 검증과 병합 권한 경로다. 원격 저장소에 병합을 실행하지 않았다. |

## 기능 확장

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [표시 이름 변경](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [피드백과 할 일 동시 등록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [작업 일정 타임라인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [시작일·마감일 지정](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-3822) | 코드 대조 | account-profile.tsx · task-timeline.tsx · workspace-activity.tsx · workspace.tsx |
| [마감순 내 작업과 최근 음원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [플랜·사용량·구독 관리](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [어엿비에서 음원 직접 게시](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |
| [공개 회원가입](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=30-2) | 조건부 | 가입 버튼은 공개 플래그를 켠 상태로 촬영했다. 실제 Logto 이메일 발송은 미검증. |

## 음원 목록

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [음원 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-437) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [첫 음원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [음원 검색 결과 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [음원 목록 로딩](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [음원 목록 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [보관한 음원 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [검토자 음원 목록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=13-2) | 코드 대조 | media-library.tsx |
| [새 음원 업로드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-671) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |

## 업로드

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [수정본 업로드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |
| [파일 전송 · 취소](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |
| [업로드 실패 · 재시도](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |
| [버전 등록 이어가기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-951) | 코드 대조 | upload.tsx · web_uploads.go |
| [음원 보관](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |
| [음원 복원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |
| [원본 다운로드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=15-2) | 코드 대조 | upload.tsx · web_uploads.go |

## 음원 플레이어

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [음원 리뷰](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-1208) | 실행 확인 | WAV 재생·메타데이터 확인. |
| [음원 재생 중](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 실행 확인 | WAV 재생·메타데이터 확인. |
| [파형 구간 지정](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 코드 대조 | version-review.tsx · review-waveform.tsx |
| [선택 구간 듣기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 코드 대조 | version-review.tsx · review-waveform.tsx |
| [겹친 피드백 마커](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 코드 대조 | version-review.tsx · review-waveform.tsx |
| [버전 기록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [이전 버전 검토](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 코드 대조 | version-review.tsx · review-waveform.tsx |
| [버전 처리 대기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=16-2) | 코드 대조 | version-review.tsx · review-waveform.tsx |

## 음원 상태

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [재생 준비 중](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |
| [오디오 처리 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |
| [지원하지 않는 오디오](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 화면 차이 | 처리 실패 원인을 재생 준비 상태에 표시한다. |
| [재생 접근 오류](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |
| [등록된 버전 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |
| [보관된 음원 리뷰](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |
| [모바일 음원 리뷰](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=18-2) | 코드 대조 | media-library.tsx · web_media_worker.go |

## 피드백 작성

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [지점 피드백 작성](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-1892) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [구간 피드백 작성](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [피드백 초안 복원](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 화면 차이 | 같은 프로젝트·버전에서 입력을 복원한다. |
| [피드백 저장 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [피드백 대화](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=92-2581) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [피드백에 답글](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [피드백 수정](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 코드 대조 | version-review.tsx · feedback-composer.tsx |
| [해결된 피드백](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=19-2) | 코드 대조 | version-review.tsx · feedback-composer.tsx |

## 피드백과 작업 연결

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [피드백 정렬·필터](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=14-2) | 코드 대조 | version-notes.tsx · review-task-links.tsx |
| [연결된 작업](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=14-2) | 코드 대조 | version-notes.tsx · review-task-links.tsx |
| [직접 링크로 연 피드백](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=14-2) | 코드 대조 | version-notes.tsx · review-task-links.tsx |
| [피드백 없음](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=14-2) | 코드 대조 | version-notes.tsx · review-task-links.tsx |

## 피드백 수정·삭제

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [피드백 관리 메뉴](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=28-2) | 코드 대조 | version-notes.tsx · web_notes.go |
| [피드백 삭제 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=28-2) | 코드 대조 | version-notes.tsx · web_notes.go |
| [피드백 링크 복사](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=28-2) | 코드 대조 | version-notes.tsx · web_notes.go |
| [작성 중인 버전 이동](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=28-2) | 코드 대조 | version-notes.tsx · web_notes.go |

## 인증과 접근

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [공유 작업 열기 · 로그인 필요](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10355) | 코드 대조 | workspace-manager.tsx · workspace-invitations.tsx · login.go |
| [로그인 후 같은 작업으로 복귀](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10393) | 코드 대조 | workspace-manager.tsx · workspace-invitations.tsx · login.go |
| [삭제·권한 철회된 작업 링크](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10556) | 코드 대조 | workspace-manager.tsx · workspace-invitations.tsx · login.go |
| [개인 작업공간 선택 결과](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9422) | 실행 확인 | Go 가입·입장·권한 통합 테스트. |
| [조직 역할과 프로젝트 참여 범위](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9535) | 조건부 | 브라우저 캡처에는 합성 팀 응답을 사용한다. 배포 조직 API 호출은 미검증. |
| [조직 역할 변경 · 영향 범위](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9651) | 조건부 | 역할 변경 API와 UI 근거가 있다. 배포 Logto 조직 동기화는 미검증. |
| [팀 초대 · 프로젝트 초대와 별도](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9812) | 조건부 | 팀 초대 발급과 취소 API·화면이 있다. 실메일 전송은 이번 대상에 포함하지 않았다. |
| [팀 초대 발급 · 응답 대기와 취소](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-9962) | 코드 대조 | workspace-manager.tsx · workspace-invitations.tsx · login.go |
| [팀 소속 누락으로 프로젝트 이동 거절](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10107) | 실행 확인 | Go 가입·입장·권한 통합 테스트. |
| [조직·프로젝트 접근 권한 상실](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10236) | 실행 확인 | Go 가입·입장·권한 통합 테스트. |

## 게스트

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [소유자 · 프로젝트 전용 게스트 초대](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-3) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 내 초대의 범위 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-274) | 실행 확인 | 게스트 링크의 진입 및 철회 후 차단 확인. |
| [게스트 · 참여 프로젝트만 표시](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-316) | 화면 차이 | 공통 프로젝트 목록에서 허용된 프로젝트만 나타난다. 별도 게스트 홈 레이아웃은 없다. |
| [게스트 · 허용된 음원 열기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-369) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 허용된 작업과 결과 버전](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=71-2) | 화면 차이 | 공통 작업 상세를 읽기 전용으로 표시한다. |
| [게스트 · 다른 프로젝트 주소 접근 거절](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-1006) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 초대 만료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10318) | 실행 확인 | 게스트 링크의 진입 및 철회 후 차단 확인. |
| [게스트 · 음원 청취와 피드백](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=91-438) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 접근 범위를 유지한 재생](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=71-2) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 구간 탐색](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=71-2) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |
| [게스트 · 피드백 작성](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=71-2) | 코드 대조 | invite/[token] · project-screen.tsx · invitations.go |

## 상세 리뷰 상태

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [파형 드래그 탐색](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-15318) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [키보드 탐색 · 포커스와 조작 안내](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-15912) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [검토자 · 다른 사람의 피드백](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-12451) | 화면 차이 | 리스트와 대화는 공유하고, 관리 버튼의 표시 권한이 바뀐다. |
| [검토자 · 내 피드백 다시 열기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-13020) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [검토자 · 내 피드백 해결](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-13593) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [편집자 · 다른 사람의 피드백 다시 열기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-14166) | 화면 차이 | 프로젝트 편집 권한을 확인한 뒤 같은 피드백 대화에서 처리한다. |
| [편집자 · 다른 사람의 피드백 해결](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-14742) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [첫 페이지 · 피드백 더 보기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-10637) | 코드 대조 | version-review.tsx · version-notes.tsx · review-waveform.tsx |
| [추가 로딩 완료 · 포커스 유지](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-11230) | 화면 차이 | 기존 목록을 유지하고 더 보기 버튼을 쓴다. 시안대로 새 항목에 포커스를 옮기는 동작은 검증하지 않았다. |
| [추가 로딩 실패 · 이미 본 목록 유지](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-11851) | 화면 차이 | 기존 목록과 공통 재시도를 사용한다. |

## 보드 상태

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [같은 열 안에서 순서 이동](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-2) | 화면 차이 | 키보드 대안은 카드 메뉴의 위·아래 이동이다. 시안의 맨 위 이동 문구와 다르다. |
| [이동 결과 · 새 순서 저장](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-370) | 화면 차이 | 결과는 보드와 이동 안내에 표시된다. |
| [일반 상태 이동 · 진행 중에 바로 저장](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-733) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [이동 저장 실패 · 이전 순서 복구](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-1094) | 코드 대조 | task-board.tsx · task-drag.tsx · web_tasks.go |
| [할 일 열에서 이름만 입력해 빠른 생성](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-1460) | 코드 대조 | task-board.tsx · task-drag.tsx · web_tasks.go |
| [빠른 생성 완료 · 보드에서 바로 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-1825) | 코드 대조 | task-board.tsx · task-drag.tsx · web_tasks.go |
| [담당자별 그룹 · 미할당 포함](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-2209) | 코드 대조 | task-board.tsx · task-drag.tsx · web_tasks.go |
| [완료 도중 피드백 변경 · 다시 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-2561) | 화면 차이 | 동시 수정은 공통 409 최신 상태 확인으로 돌아간다. 디자인과 같은 독립 피드백 비교 화면은 없다. |

## 일정과 대시보드

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [일정 막대 이동 · 시작일과 마감일 함께 표시](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-2777) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [일정 막대 끝 조절 · 마감일 변경](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-2989) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |
| [일정 저장 완료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-3201) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [조절한 마감일 저장 완료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-3405) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |
| [일정 저장 실패 · 원래 날짜 복구](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-3617) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |
| [마감순 그룹 5개 · 지연과 다음 주 이후](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-3941) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |
| [100개 초과 작업 · 첫 페이지와 필터](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4127) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |
| [100개 초과 작업 · 마지막 페이지](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-4306) | 코드 대조 | task-timeline.tsx · workspace-activity.tsx |

## 결제·구독

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [플랜과 사용량 · 구독 관리 진입](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6036) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [구독 플랜 비교와 변경 선택](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6184) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [결제 수단과 청구 변경 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6306) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [결제 실패 · 기존 구독 유지](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6443) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [결제와 플랜 변경 완료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6589) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [저장공간·멤버 한도 도달](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6709) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [결제 내역과 청구서](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-6859) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [구독 해지 전 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7002) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [구독 해지 예약 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7132) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [구독 종료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17837) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [예시 청구서](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17684) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |
| [10월 청구서](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-20099) | 보류 | 유료화 정책·결제사 결정 전 개발을 보류했다. |

## 어엿비 게시

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [어엿비 렌더 연결 정보와 게시 대상](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7265) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |
| [웹에 버전 등록 중](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7422) | 화면 차이 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. 데스크톱은 파일 전송·등록 결과를 표시하고, 지속되는 인코딩 상태는 웹 버전에서 확인한다. |
| [등록 실패 · 같은 렌더 다시 등록](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7570) | 실행 확인 | Go 테스트의 기존 내용 유지와 재시도. |
| [새 버전 · 출처 스냅샷과 커밋 링크](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-7735) | 화면 차이 | WAV 재생·메타데이터 확인. 스냅샷과 WAV 해시는 검증했다. 이번 실제 게시에는 선택적인 커밋과 리뷰 ID를 연결하지 않았다. |
| [새 음원 등록 실패](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-19030) | 코드 대조 | Ayotbi SamtdiPublishPanel.cpp · NativeAccount.cpp · web_uploads.go |
| [새 음원 이름 입력](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-18719) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |
| [새 음원 전송 중](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-18879) | 화면 차이 | 등록된 뒤 처리 상태는 웹에서 확인한다. |
| [새 음원 등록 완료](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-19195) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |
| [어엿비 프로젝트 선택](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-19932) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |
| [어엿비 게시 대상 선택](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-19768) | 실행 확인 | 어엿비 GUI → Go·S3·FFmpeg → 웹 검증. |

## 모바일

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [프로젝트 선택](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-40) | 실행 확인 | Chrome에서 링크·레이아웃을 확인. |
| [음원 목록과 업로드 진입](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-87) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [파일 선택과 업로드](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-127) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [음원 탭 · 전송 진행 표시](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-177) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [작업 탭으로 이동해도 업로드 진행 표시](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-232) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [전송 완료 · 파형과 재생본 준비](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-291) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [파형 재생과 모바일 피드백 진입](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-358) | 실행 확인 | WAV 재생·메타데이터 확인. |
| [구간 지정과 시작·끝 조작](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=77-2) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [타임코드가 고정된 전체 화면 입력](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-653) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [피드백 등록 결과와 작업 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-704) | 실행 확인 | 두 Chrome 계정에서 저장·재조회 확인. |
| [피드백에서 작업 만들기](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-1007) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |
| [작업 상세와 피드백 복귀](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=93-1056) | 코드 대조 | styles.css · workspace.tsx · version-review.tsx |

## 모바일 복구

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [공유 작업 로그인 · 접근 권한 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=104-257) | 코드 대조 | upload.tsx · request-states.tsx · version-review.tsx |
| [업로드 실패 · 입력 보존과 재시도](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=104-79) | 코드 대조 | upload.tsx · request-states.tsx · version-review.tsx |
| [전송 취소 확인](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=104-142) | 코드 대조 | upload.tsx · request-states.tsx · version-review.tsx |
| [재생 실패 · 다시 시도](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=104-221) | 코드 대조 | upload.tsx · request-states.tsx · version-review.tsx |

## Figma 인덱스

| Figma 화면 | 판정 | 구현·검증 근거 |
| --- | --- | --- |
| [사맛디 · 남은 기능 프로토타입](https://www.figma.com/design/FjzyBt184yHOLeJ02Mt6Xr?node-id=128-17995) | 화면 차이 | Figma 검토용 시작 프레임이다. |
