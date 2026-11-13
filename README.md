# 사맛디 (Samtdi)

비공개 음악 협업 플랫폼. [구현 계획](docs/web-implementation-plan.md)과 [PR 계획](docs/web-pr-plan.md), [UI 수정과 검증 기록](docs/web-ui-redesign-plan.md)을 참고하세요.

Go 협업 서비스와 기존 데이터 마이그레이션의 이관 출처는 [Ayotbi 562f8d0](https://github.com/whizzkid1452/Ayotbi/tree/562f8d00221c003ca1224fa87edca2b061b8c586/services/collaboration)입니다. 모듈 import 경로와 검증 도구 입력 경로를 이 저장소에 맞췄습니다.

서버 빌드는 `services/collaboration`에서 `go build ./...`로 실행합니다. 네이티브 호환 검사는 격리 PostgreSQL과 Ayotbi가 빌드한 프로젝트 도구·버전 도구·렌더 작업자 경로를 환경에 설정한 뒤 `ops/verify-collaboration.sh`를 실행합니다.

## 로컬 웹 실행

Go 1.25, Node.js 22, pnpm 10.15, Docker Compose와 AWS CLI가 필요합니다. 로컬 Compose는 PostgreSQL·Versity S3 Gateway·Dex를 루프백에만 게시합니다.

```sh
docker compose -f ops/compose.yaml up -d --wait
set -a
. ops/local.env
set +a
aws --endpoint-url "$AYOTBI_S3_ENDPOINT" s3 mb "s3://$AYOTBI_S3_BUCKET"
(cd services/collaboration && go run ./cmd/ayotbi-collaboration)
```

별도 터미널에서 `cd apps/web && pnpm install --frozen-lockfile && pnpm dev`를 실행하고 `http://127.0.0.1:3100`을 엽니다. 로컬 데모 로그인은 `owner@example.test` / `samtdi-demo`입니다. 검토자 계정은 프로젝트 소유자가 `reviewer@example.test`에 초대한 뒤 사용합니다. 개발용 계정·비밀번호·OIDC 설정은 로컬 환경에만 적용합니다.

스토리지 버킷이 이미 있으면 생성 대신 조회로 확인합니다. `curl http://127.0.0.1:8080/livez`는 프로세스 상태, `/readyz`는 DB·설정된 스토리지 연결 상태를 확인합니다. 기존 `/healthz`는 DB 상태를 유지합니다.

`ops/verify-web.sh`는 격리 PostgreSQL로 실행합니다. API 형식은 `contracts/openapi.json`을 수정하고 `apps/web`에서 `pnpm generate:api`를 실행해 갱신합니다.

미디어 처리에는 FFmpeg·FFprobe가 필요합니다. API와 같은 환경을 별도 터미널에 적용하고 `services/collaboration`에서 `go run ./cmd/ayotbi-collaboration media-worker`를 실행합니다. 처리 작업은 최대 8분, 임대는 10분입니다. 전송이나 저장 오류는 최대 세 번 시도하며, 형식 오류는 새 업로드가 필요합니다. 로컬 설정은 파일당 500 MB, 30분, 모노·스테레오를 허용합니다.

[운영과 복원](docs/web-operations.md) · [MVP 검증 결과와 재현](docs/web-pilot-verification.md)
