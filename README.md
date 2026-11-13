# 사맛디 (Samtdi)

비공개 음악 협업 플랫폼. [구현 계획](docs/web-implementation-plan.md)과 [PR 계획](docs/web-pr-plan.md)을 참고하세요.

Go 협업 서비스와 기존 데이터 마이그레이션의 이관 출처는 [Ayotbi 562f8d0](https://github.com/whizzkid1452/Ayotbi/tree/562f8d00221c003ca1224fa87edca2b061b8c586/services/collaboration)입니다. 모듈 import 경로와 검증 도구 입력 경로를 이 저장소에 맞췄습니다.

서버 빌드는 `services/collaboration`에서 `go build ./...`로 실행합니다. 네이티브 호환 검사는 격리 PostgreSQL과 Ayotbi가 빌드한 프로젝트 도구·버전 도구·렌더 작업자 경로를 환경에 설정한 뒤 `ops/verify-collaboration.sh`를 실행합니다.
