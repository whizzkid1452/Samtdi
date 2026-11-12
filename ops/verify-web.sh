#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
: "${AYOTBI_TEST_DATABASE_URL:?격리 PostgreSQL 연결 주소를 설정하세요.}"

cd "$root/services/collaboration"
go test -race -skip 'TestGitSmartHTTP|TestGitLFSObjectRoundTrip|TestHeadlessProjectTool|TestReceiveProtectsSharedVersions' ./...
go vet ./...
go build ./...
