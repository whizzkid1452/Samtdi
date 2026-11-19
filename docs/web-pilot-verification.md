# 사맛디 MVP 검증 기록

2026년 11월 12일에 로컬 Next.js, Go API, PostgreSQL 14, Versity S3 Gateway, Dex, FFmpeg 작업자를 사용했습니다. Node.js 22.14.0에서 최종 브라우저 검증을 실행했습니다.

| 검증                         | 결과                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 서로 다른 브라우저의 두 계정 | Chrome 157과 Firefox 159에서 로그인과 초대 수락, v1 WAV 업로드, 타임코드 노트, v2 VBR MP3, 카드·검토 요청·완료, 답글 알림·읽음, 이력과 JSON 반출을 확인          |
| 재생·시간 좌표               | WAV의 3초 메타데이터와 실제 재생 시간 증가, 키보드 탐색, 짧아진 v2 뒤에도 v1 노트와 원본 바이트 보존을 확인                                                      |
| 모바일 크기                  | Playwright WebKit 27.2의 iPhone 13 화면 설정에서 오디오 메타데이터와 노트 작성을 확인                                                                            |
| 권한과 실패                  | 범위 밖 노트, 타인 수정, 오래된 revision, 미해결 노트 확인 없는 완료, 멤버 제거 후 Range·반출 요청을 거절. 손상 WAV 처리 실패 후 이전 ready 버전 유지            |
| 작업 임대                    | 격리 PostgreSQL에서 활성 임대 중복 획득 차단, 만료 임대 재획득과 이전 작업자의 확정 거절을 확인                                                                  |
| 데이터 복원                  | 별도 빈 DB·버킷으로 형식 2의 20개 테이블과 오디오 객체 6개를 복원. 로컬 소량 데이터의 백업 약 0.22초, 복원 약 0.14초. 새 로그인으로 기존 버전을 열고 반출을 확인 |
| 네이티브 호환                | 격리 DB와 기존 Ayotbi 실행 파일로 인증, Git/LFS, 데스크톱 전송, 리뷰 렌더와 스냅샷 복원 검사 통과                                                                |
| 프로젝트 전환                | 동일한 React 키를 사용한 형제 패널이 중복 남는 문제를 재현. 패널별 키 적용 후 같은 전환에서 음원 패널 한 개를 확인                                               |

복원 시간은 이 로컬 데이터의 관측값입니다. 실기기 iOS Safari·Android Chrome, 운영 OIDC·HTTPS, 운영 규모 부하와 제작팀 파일럿 참여는 배포 환경에서 확인해야 합니다.

## 다시 실행하기

[로컬 실행 안내](../README.md)의 API·웹·미디어 작업자를 먼저 시작합니다. 아래 명령은 개발용 계정과 격리 저장소에서 프로젝트, 음원, 노트와 카드를 생성합니다.

```sh
cd apps/web
pnpm install --frozen-lockfile
PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install chromium firefox webkit
SAMTDI_VERIFY_MOBILE=1 pnpm verify:pilot
```

설치된 Chrome을 쓰려면 `SAMTDI_CHROME_CHANNEL=chrome`을 설정합니다. `ops/verify-web.sh`로 별도의 PostgreSQL에서 Go 검사·빌드를 실행합니다. 운영 준비와 복원은 [운영 문서](web-operations.md)에 정리했습니다.

## Mantine 적용 검증

2026년 11월 19일에 격리한 PostgreSQL, Dex OIDC, Versity Gateway, FFmpeg 환경에서 최종 웹 빌드를 검증했습니다.

- `pnpm lint`, `pnpm test` 4개, `pnpm build`, `pnpm typecheck`와 `ops/verify-web.sh`를 통과했습니다.
- Chrome·Firefox 및 모바일 크기 WebKit에서 WAV 업로드, 파형 조작과 피드백, 작업 배정, MP3 수정본 검토, 알림, 권한 철회까지 확인했습니다. 200개가 넘는 피드백의 페이지 이동과 기존 시간 링크도 확인했습니다.
- 검토자로 다시 초대한 계정으로 음원·작업·피드백 링크를 열었습니다. 피드백 작성 버튼은 표시되고 업로드·작업 생성 버튼은 표시되지 않았습니다.
- 작업공간 선택·생성·멤버 제거·프로젝트 연결 UI는 Chrome 390px 화면에서 격리된 API 응답으로 확인했습니다. 파일럿 인증은 Dex를 사용했습니다.

별도 로컬 웹 포트를 사용하는 경우 `SAMTDI_VERIFY_ORIGIN`에 해당 루프백 주소를 지정합니다.

```sh
SAMTDI_VERIFY_ORIGIN=http://127.0.0.1:3218 \
  SAMTDI_CHROME_CHANNEL=chrome SAMTDI_VERIFY_MOBILE=1 SAMTDI_VERIFY_PAGINATION=1 \
  pnpm verify:pilot
```

### 초기 리소스 전송량

Chrome의 새 컨텍스트에서 동일한 API 응답과 1440×900 화면으로 Next.js 프로덕션 빌드를 열었습니다. 초기 HTML이 참조하는 JS·CSS의 `encodedBodySize` 합계를 비교했습니다. 세 화면에서 같은 초기 번들이 로드됐습니다.

| 초기 리소스 | 적용 전 `9836f3a` | Mantine 적용 | 차이 |
| --- | ---: | ---: | ---: |
| JavaScript | 194,688 B | 280,746 B | +86,058 B |
| CSS | 3,936 B | 40,708 B | +36,772 B |
| 합계 | 198,624 B | 321,454 B | +122,830 B |

프로젝트 목록·작업 보드·음원 리뷰가 같은 앱 경로의 클라이언트 코드와 전역 Mantine 스타일을 불러옵니다. 위 수치는 로컬 전송량이며 실제 사용 환경의 로드 시간은 측정하지 않았습니다.
