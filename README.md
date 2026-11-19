# 사맛디 (Samtdi)

비공개 음악 협업 플랫폼. [구현 계획](docs/web-implementation-plan.md)과 [PR 계획](docs/web-pr-plan.md), [UI 수정과 검증 기록](docs/web-ui-redesign-plan.md)을 참고하세요. 후속 [음원 리뷰 UX 개선과 검증 기록](docs/audio-review-ux-plan.md)도 참고하세요.

Go 협업 서비스와 기존 데이터 마이그레이션의 이관 출처는 [Ayotbi 562f8d0](https://github.com/whizzkid1452/Ayotbi/tree/562f8d00221c003ca1224fa87edca2b061b8c586/services/collaboration)입니다. 모듈 import 경로와 검증 도구 입력 경로를 이 저장소에 맞췄습니다.

서버 빌드는 `services/collaboration`에서 `go build ./...`로 실행합니다. 네이티브 호환 검사는 격리 PostgreSQL과 Ayotbi가 빌드한 프로젝트 도구·버전 도구·렌더 작업자 경로를 환경에 설정한 뒤 `ops/verify-collaboration.sh`를 실행합니다.

리뷰 렌더는 Ayotbi의 `render.json` 형식 v1과 v2를 지원합니다. v2는 `sourceDocumentHash`가 리뷰 대상 커밋의 `project.json` SHA-256과 일치해야 저장됩니다.

## 로컬 웹 실행

Go 1.25, Node.js 22, pnpm 10.15, Docker Compose와 AWS CLI가 필요합니다. 로컬 Compose는 PostgreSQL·Versity S3 Gateway·Logto OSS를 루프백에만 게시합니다. 첫 실행 전 [Logto 설정과 기존 계정 연결](docs/logto-local-setup.md)을 완료하세요.

```sh
docker compose -f ops/compose.yaml up -d --wait
set -a
. ops/local.env
. .local/logto.env
set +a
aws --endpoint-url "$AYOTBI_S3_ENDPOINT" s3 mb "s3://$AYOTBI_S3_BUCKET"
(cd services/collaboration && go run ./cmd/ayotbi-collaboration)
```

별도 터미널에서 `cd apps/web && pnpm install --frozen-lockfile && pnpm dev`를 실행하고 `http://127.0.0.1:3100`을 엽니다. Logto 설정의 `--demo`를 사용했으면 사용자 이름 `owner` / 비밀번호 `Samtdi-demo-2026!`로 로그인합니다. 검토자 `reviewer`는 프로젝트 초대 후 사용합니다. 개발용 계정·비밀번호·OIDC 설정은 로컬 환경에만 적용합니다.

스토리지 버킷이 이미 있으면 생성 대신 조회로 확인합니다. `curl http://127.0.0.1:8080/livez`는 프로세스 상태, `/readyz`는 DB·설정된 스토리지 연결 상태를 확인합니다. 기존 `/healthz`는 DB 상태를 유지합니다.

`ops/verify-web.sh`는 격리 PostgreSQL로 실행합니다. API 형식은 `contracts/openapi.json`을 수정하고 `apps/web`에서 `pnpm generate:api`를 실행해 갱신합니다.

웹 재생 위치 보간 검사는 `cd apps/web && pnpm test`로 실행합니다(Node.js 22.6 이상). wavesurfer.js는 서버에서 생성한 파형 데이터를 그리고 Regions로 선택 구간을 표시·조절합니다. 기존 HTML 오디오의 재생 시간을 기준으로 플레이헤드를 보간하며 탐색·정지·버퍼링 시 실제 위치로 다시 맞춥니다. 댓글과 구간 입력의 시간은 밀리초 단위입니다. [외부 라이선스 고지](THIRD_PARTY_NOTICES.md)

미디어 처리에는 FFmpeg·FFprobe가 필요합니다. API와 같은 환경을 별도 터미널에 적용하고 `services/collaboration`에서 `go run ./cmd/ayotbi-collaboration media-worker`를 실행합니다. 처리 작업은 최대 8분, 임대는 10분입니다. 전송이나 저장 오류는 최대 세 번 시도하며, 형식 오류는 새 업로드가 필요합니다. 로컬 설정은 파일당 500 MB, 30분, 모노·스테레오를 허용합니다.

[운영과 복원](docs/web-operations.md) · [MVP 검증 결과와 재현](docs/web-pilot-verification.md)

웹 공통 UI는 Mantine과 사맛디 테마를 사용합니다. [Mantine 적용 검증과 초기 전송량 비교](docs/web-pilot-verification.md#mantine-적용-검증)를 참고하세요.

## 작업 보드

보드에서 카드를 끌어 컬럼 사이로 이동하거나 카드 위·아래에 놓아 순서를 저장합니다. 더 보기 메뉴의 이동 버튼으로도 같은 작업을 수행할 수 있습니다. 검토 요청·완료로 전환할 때는 결과와 미해결 피드백을 확인합니다. 다른 사용자가 먼저 수정한 카드는 덮어쓰지 않고 최신 상태를 다시 불러옵니다.

보드 조작에는 Apache-2.0의 Pragmatic drag and drop을 사용합니다. [외부 라이선스 고지](THIRD_PARTY_NOTICES.md)를 참고하세요.
