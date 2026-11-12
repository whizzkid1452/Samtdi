#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
: "${AYOTBI_TEST_DATABASE_URL:?격리 PostgreSQL 연결 주소를 설정하세요.}"
export AYOTBI_TEST_PROJECT_DOCUMENT="${AYOTBI_TEST_PROJECT_DOCUMENT:-$root/tests/fixtures/project-tools/base.json}"
: "${AYOTBI_TEST_PROJECT_TOOL:?Ayotbi 프로젝트 도구의 실행 경로를 설정하세요.}"
: "${AYOTBI_TEST_VERSION_TOOL:?Ayotbi 버전 도구의 실행 경로를 설정하세요.}"
: "${AYOTBI_TEST_RENDER_WORKER:?네이티브 리뷰 렌더 작업자의 실행 경로를 설정하세요.}"

for executable in "$AYOTBI_TEST_PROJECT_TOOL" "$AYOTBI_TEST_VERSION_TOOL" "$AYOTBI_TEST_RENDER_WORKER"; do
    if [[ ! -x "$executable" ]]; then
        printf '실행 파일이 필요합니다. %s\n' "$executable" >&2
        exit 1
    fi
done

command -v git >/dev/null
command -v git-lfs >/dev/null
cd "$root/services/collaboration"
GOTOOLCHAIN=local go test -race -v ./...
GOTOOLCHAIN=local go vet ./...
