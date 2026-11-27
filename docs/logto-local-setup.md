# Logto OSS 연결과 기존 계정 이관

무료 Logto OSS 1.46.0을 별도 인증·조직 서비스로 실행합니다. Go는 현재 세션과 프로젝트별 owner/editor/reviewer 권한을 유지하며 팀 작업공간의 현재 조직 소속도 검사합니다. 이 문서는 실행·이관·검증 절차를 다룹니다. 설계 판단은 기존 Notion 구조도에서 관리합니다.

## 로컬 설정

1. `docker compose -f ops/compose.yaml up -d --wait`로 영속 볼륨을 사용하는 서비스를 시작합니다. Logto는 3001, 관리 콘솔은 3002, 전용 PostgreSQL은 56545입니다. 사맛디 DB와 분리합니다. `docker compose down -v`는 계정을 포함한 개발 데이터를 삭제하므로 일반 재시작에 사용하지 않습니다.
2. `http://127.0.0.1:3002`에서 운영자 계정을 만듭니다. Console에서 Management API의 `all` 권한을 가진 Machine-to-machine 앱을 만들고 client credentials 방식으로 관리 토큰을 얻습니다. [공식 관리 API 연결 안내](https://docs.logto.io/end-user-flows/organization-experience/setup-app-service-with-management-api)를 따릅니다. 이 초기 토큰은 설정 실행 뒤 환경에서 제거합니다.
3. 토큰을 `LOGTO_BOOTSTRAP_TOKEN` 환경에 주입하고 저장소 루트에서 `node ops/setup-logto.mjs --demo`를 실행합니다. 실제 계정으로 운영할 때는 `--demo`를 생략합니다. 스크립트는 웹·서버 앱과 조직 역할을 구성하고 자격을 권한 600인 `.local/logto.env`에 저장합니다. 재실행은 같은 이름의 구성을 재사용하며 기존 콜백을 보존합니다. 설정 목록은 100개씩 끝까지 확인합니다.
4. `set -a`, `. ops/local.env`, `. .local/logto.env`, `set +a` 순서로 환경을 적용한 뒤 README의 API·웹·작업자 실행을 따릅니다. 다른 웹 포트는 설정 스크립트 실행 시 `AYOTBI_ORIGIN`으로 지정합니다. 다른 Logto 주소는 `SAMTDI_LOGTO_ENDPOINT`로 지정합니다.

데모 계정은 `owner`와 `reviewer`, 비밀번호는 `Samtdi-demo-2026!`입니다. 이 설정은 루프백에만 허용하며 사용자 이름·비밀번호 로그인을 사용합니다. 이메일 발송은 포함하지 않습니다. 공개 가입과 실제 이메일 인증은 운영 이메일 커넥터·가입 정책을 구성한 뒤 도입합니다. 현재 새 계정은 최초 운영자, 프로젝트 초대 또는 기존 작업공간의 팀원으로 진입합니다.

Docker를 사용하지 않을 때는 공식 `logto.tar.gz` 배포본과 별도 PostgreSQL을 사용할 수 있습니다. Logto가 지원하는 Node LTS 버전을 사용하고 `DB_URL=... npm run cli -- db seed --skip-when-exists` 후 `DB_URL=... ENDPOINT=... ADMIN_ENDPOINT=... npm start`로 실행합니다. 이번 Mac 검증은 Docker 소켓 연결 문제로 공식 배포본·Node 22.23.4·격리 PostgreSQL을 사용했습니다. Compose 설정 검증과 실제 컨테이너 실행 검증을 구분합니다.

## 기존 계정 연결

공급자를 교체해도 이메일만으로 계정을 자동 합치지 않습니다. Logto에서 같은 이메일의 실제 계정을 확인한 뒤 운영자가 내부 account UUID와 Logto user ID를 명시해 연결합니다. 계정 UUID, 노트·작업 작성자와 프로젝트 멤버십은 유지합니다.

```sh
# 위 환경을 적용한 상태에서 실행합니다. ID에는 실제 확인한 값을 사용합니다.
cd services/collaboration
go run ./cmd/ayotbi-collaboration link-logto-identity ACCOUNT_UUID LOGTO_USER_ID
```

명령은 Logto 관리 API의 계정·이메일과 기존 계정을 대조하며 다른 계정에 연결된 identity를 빼앗지 않습니다. 관리 토큰은 브라우저에 전달하지 않습니다. 전환 전 사맛디와 Logto DB를 각각 백업하고 연결할 계정 목록을 확인합니다.

기존 Dex 프로젝트는 기존 접근 권한을 유지합니다. 프로젝트 설정에서 작업공간에 연결할 때 현재 프로젝트 멤버 모두의 Logto 계정 연결과 대상 조직 소속을 확인합니다. 하나라도 빠졌으면 이동을 거절합니다. 웹의 신규 프로젝트는 작업공간을 명시합니다. 기존 native 클라이언트가 제목만 보내는 생성 계약은 프로젝트별 ACL을 사용하는 공유 프로젝트로 보존하며 작업공간 연결은 웹 설정에서 수행합니다. native 클라이언트도 `workspace_id`를 전달하면 같은 조직 검사를 적용합니다. 기존 Dex 개발 환경만 실행하려면 `docker compose -f ops/compose.yaml --profile legacy-dex up -d postgres storage oidc` 후 `ops/local.dex.env`를 적용하고 Logto 관련 환경 변수를 설정하지 않습니다.

## 팀과 접근 권한

- 작업공간 생성자는 Logto의 `samtdi-owner`, 일반 팀원은 `samtdi-member`, 프로젝트 초대로 들어온 외부 협업자는 `samtdi-guest`입니다. owner/member는 프로젝트를 만들 수 있습니다. 팀 소유권은 팀 관리 범위이며 모든 프로젝트의 열람 권한을 자동 부여하지 않습니다.
- 팀 소유자는 멤버 관리에서 이미 가입한 이메일을 팀에 추가하거나 일반 멤버를 제거합니다. 소유자 제거·탈퇴는 지원하지 않습니다. 다른 사용자에게 팀 소유권을 넘기는 UI는 이번 범위에 포함하지 않습니다.
- 프로젝트 접근에는 팀 소속과 해당 프로젝트의 멤버십이 모두 필요합니다. 기존 세션이 남아 있어도 Logto에서 팀원을 제거하면 새 API·미디어 Range·Git/LFS 요청과 목록·대시보드·알림에서 접근을 거절합니다. 로그인 서비스 장애는 접근 허용으로 처리하지 않습니다. 로그아웃은 외부 서비스 장애 중에도 사맛디 세션을 삭제합니다.
- 작업공간 생성 요청 UUID를 보존합니다. DB 준비 → 조직 생성과 외부 ID 보관 → 소유자 연결 → 활성화 순서로 처리하며 같은 요청의 재실행은 재개합니다. 조직 생성 응답이 유실되면 customData의 요청·계정 ID로 재조회합니다. 생성 여부를 확인할 수 없으면 중복 POST를 보내지 않고 준비 중으로 남깁니다. 운영자는 Logto의 동일 마커 유무를 확인한 뒤 문제를 복구합니다.

## 백업과 검증

사맛디 스냅샷 v3에는 계정 identity 연결과 작업공간을 포함합니다. 이전 v1/v2 읽기를 유지하며 v2의 프로젝트 컬럼과 마이그레이션 목록은 당시 형식으로 읽습니다. Logto의 identity·조직·역할은 별도 DB의 원본이므로 사맛디 스냅샷만으로 복구되지 않습니다. Logto DB를 별도로 백업하고 두 DB의 연결 ID를 함께 검증합니다.

검증은 격리 DB의 `ops/verify-web.sh`, 웹 lint·typecheck·build, 실제 Logto 로그인·작업공간 생성·프로젝트 초대·멤버 제거 흐름으로 수행합니다. 운영 HTTPS·메일·소셜 로그인·실기기와 실제 컨테이너 실행은 별도 검증 항목입니다. GitHub Actions는 비활성 상태를 유지합니다.

2026-11-18 Mac에서 실제 Logto의 웹 로그인, 기존 계정 ID 보존, 팀 생성·멤버 추가·제거, 프로젝트 연결과 두 작업공간의 접근 분리를 확인했습니다. 네이티브 PKCE 콜백·일회용 코드 교환·로그아웃과 제목만 보내는 기존 프로젝트 생성도 확인했습니다. 중단된 조직 생성의 마커 복구와 같은 UUID의 동시 생성은 하나의 조직으로 수렴했습니다.

격리 DB의 Go race 테스트·vet·build와 웹 lint·typecheck·build가 통과했습니다. Go 검사는 팀원 제거 후 목록·내 작업·알림·재생 파일·반출 차단, 계정 정지와 인증 서비스 장애 시 거절, identity 연결과 스냅샷 v1/v2/v3 복원을 포함합니다. 별도 Logto DB도 pg_dump·pg_restore 후 사용자·조직·역할·앱·멤버십 개수가 일치함을 확인했습니다. 네이티브 바이너리를 요구하는 검사는 해당 실행 환경을 지정하지 않아 기존 테스트의 skip 조건을 유지했습니다.

## 이메일 공개 가입

Logto에 이메일 커넥터를 연결하고 로그인 경험에서 이메일 인증 가입을 켭니다. 실제 메일에서 인증 코드 발송·재발송을 확인한 뒤 사맛디 API에 `SAMTDI_PUBLIC_SIGNUP=true`를 설정합니다. 가입 버튼은 Logto의 등록 화면으로 이동합니다. 검증된 웹 로그인에서 사맛디가 계정과 개인 작업실을 PostgreSQL에 함께 저장합니다. 같은 계정으로 로그인하면 같은 작업실을 사용합니다.

개인 작업실은 생성한 계정의 작업공간 선택 목록에만 나타납니다. 해당 작업실에서 만든 프로젝트를 공유하려면 프로젝트 권한을 따로 부여합니다. [Logto 이메일 커넥터](https://docs.logto.io/connectors/email-connectors)
