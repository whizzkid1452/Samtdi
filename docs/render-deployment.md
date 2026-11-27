# 사맛디 저비용 협업 배포

## 환경 구성

웹 전용 협업 서버는 Render Free Web Service의 Docker 런타임에서 기존 Go API와 FFmpeg 작업자를 실행한다. Caddy가 Render의 단일 HTTP 포트를 받아 루프백 API로 전달한다. 외부 TLS는 Render가 종료한다. API와 작업자는 별도 프로세스로 실행하며 필수 프로세스 종료 시 컨테이너가 재시작된다. PostgreSQL과 객체 저장소는 인스턴스 밖에 두므로 인스턴스가 재시작되어도 프로젝트와 피드백이 유지된다.

- Render: 저장소 루트 `render.yaml`, main 브랜치 자동 배포, Singapore, Free, `/readyz`.
- Vercel: 기존 `apps/web` Next.js 프로젝트의 Production Branch를 main으로 유지한다. 협업 서버 준비가 완료될 때까지 `SAMTDI_LOCAL_MODE=1`을 유지한다.
- PostgreSQL: Supabase Free 전용 프로젝트의 session pooler를 사용할 수 있다(IPv4). 사맛디 전용 DB 역할과 비노출 스키마를 만든다. 데이터 API에 이 스키마를 노출하지 않고 anon/authenticated 권한을 부여하지 않는다. `AYOTBI_DATABASE_URL`은 SSL 연결, `search_path=samtdi`, 제한된 풀 크기(예: `pool_max_conns=3`)를 적용한다. 마이그레이션과 유지보수에 PostgreSQL 세션 수준 advisory lock이 사용되므로 transaction pooler는 사용하지 않는다.
- OIDC: 검증된 이메일을 ID token에 포함하는 운영 공급자를 연결한다(예: Cognito Lite Authorization Code + PKCE, confidential client, openid/email scope). 콜백 URL은 실제 웹 출처의 `/v1/auth/callback`이다. 초기 운영자는 실제 인증된 `AYOTBI_BOOTSTRAP_EMAIL`을 지정한다. 공개 웹 모드(`SAMTDI_PUBLIC_SIGNUP=true`)에서는 확인된 이메일이면 초대 없이 가입하고 개인 작업실을 받는다. 팀 참여는 팀 소유자가 발급한 이메일 지정 일회용 코드 또는 동일한 토큰을 담은 링크로만 가능하다. 프로젝트 역할은 팀 멤버십과 별도로 관리한다. Logto 전용 조직 기능은 Logto 설정을 생략한 경우 비활성화된다.
- 객체 저장소: 비공개 AWS S3 버킷을 사용한다. 실제 웹 출처만 업로드 PUT 요청의 CORS에 허용한다. 별도 자격은 전용 버킷과 필요한 작업으로 한정하고 Render의 환경 변수로 주입한다. 기존 코드의 SHA-256 체크섬·메타데이터·Range 계약을 충족하는지 확인되지 않은 S3 호환 스토리지로 임의 변경하지 않는다. AWS S3는 계정의 적용 가능한 무료 한도 및 실제 저장·전송량에 따라 소액 요금이 발생할 수 있다.

## 연결

새 무료 서비스와 DB를 별도 프로젝트로 생성하고 필요한 실제 자격을 Render 환경 변수로 설정한다. 비밀 값은 저장소와 클라이언트 공개 변수에 기록하지 않는다.
`AYOTBI_ORIGIN`은 확정한 실제 Vercel HTTPS 출처로 설정하고, 사이트 접근 및 계정 초대·프로젝트 생성·원본 업로드·처리·파형·피드백 저장을 두 계정으로 검증한다. 그 전에는 Vercel의 로컬 운영 배포에 영향을 주지 않는다.

협업 검증이 끝나면 Vercel Production 환경에서 `SAMTDI_API_ORIGIN`을 Render HTTPS 서비스 주소로 설정하고 `SAMTDI_LOCAL_MODE`를 제거해 새 main 배포를 실행한다. 로컬 작업실의 IndexedDB 데이터는 서버 DB로 자동 이전되지 않는다. 로컬 모드로 되돌리려면 설정을 복원한 후 재배포한다.

## 무료 플랜 한계

Render Free는 유휴 시 절전되고 첫 요청이 늦어질 수 있으며, 지속 백그라운드 작업자는 지원하지 않는다. 정상적인 요청이 처리되는 동안 동일 컨테이너에서 미디어 작업을 수행하고, 재시작 후 기존 DB 임대 정책을 따라 미완료 작업을 복구한다. 업로드 용량과 CPU/메모리 제한은 실제 음원·협업 규모에서 측정해야 한다. 무료 DB의 비활성 일시 중지와 사용량 제한, 음원 저장소·전송 비용도 확인한다. 이 구성은 저비용 베타용이며 SLA를 보장하지 않는다.

## 확인 상태

이 저장소의 배포 설정은 구성 준비이다. Render 컨테이너 및 실제 OIDC·PostgreSQL·S3 연결과 사용 흐름을 확인하기 전 배포 완료로 간주하지 않는다.

### Supabase Free 구성 (선택 사항)

- Supabase PostgreSQL 전용 `samtdi` 스키마 및 비노출 서비스 계정; 세션 pooler, TLS, `search_path=samtdi`, 낮은 연결 풀 크기.
- Supabase OAuth 2.1 Server를 활성화하고 Site URL은 실제 Vercel origin, Authorization Path는 `/oauth/consent`, 등록된 confidential client의 콜백은 `/v1/auth/callback`으로 설정한다. 동적 클라이언트 등록을 허용하지 않는다. 검증 이메일, 서명, audience, state, nonce와 PKCE 검증을 유지한다.
- Vercel의 공개 환경 변수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SAMTDI_OAUTH_CLIENT_ID`, `NEXT_PUBLIC_SAMTDI_FREE_STORAGE=1`. 비밀 키는 절대 공개 변수에 저장하지 않는다.
- Supabase 전용 비공개 버킷을 사용한다. Render의 `AYOTBI_S3_ENDPOINT`는 Supabase 대시보드에 표시된 직접 Storage S3 HTTPS 엔드포인트(`https://<project-ref>.storage.supabase.co/storage/v1/s3`), S3 region과 서버 전용 키를 설정한다. AWS checksum API 대신 업로드한 결과 객체의 바이트를 다시 읽어 SHA-256 및 크기와 메타데이터를 확인하며, 불일치하면 실패 처리한다.
- 무료 저장소 구성에서는 원본 및 변환 산출물 각각 45 MB 제한. PCM 44.1kHz 16-bit stereo는 약 4분 15초 이하이며, 초과 파일은 자르지 않고 실패 처리한다. Supabase 전체 저장 및 전송 무료 한도를 모니터링한다.
- 기본 SMTP는 외부 수신자 가입에 제한이 있을 수 있다. 운영 SMTP/OAuth 제공자 설정 및 실제 이메일 인증과 2계정 초대 흐름은 배포 전에 검증한다.
- 실제 S3 presigned PUT, metadata, Range GET, worker 처리, OAuth callback, DB 권한 검증은 필수이며, 통과 전까지 기존 Vercel 프리뷰를 유지한다.

### 공개 가입 배포 전 확인

- Supabase Auth에서 이메일 가입과 이메일 확인을 유지한다. 기본 SMTP는 프로젝트 팀 주소만 수신 가능하므로 일반 공개 전에 [맞춤 SMTP](https://supabase.com/docs/guides/auth/auth-smtp)를 구성한다. 도메인 발신 인증과 운영 콜백 URL을 확인하고, 가입 및 이메일 확인을 끄거나 미확인 이메일을 허용하는 방식으로 우회하지 않는다.
- Render의 `SAMTDI_PUBLIC_SIGNUP=true` 적용 후 `/readyz`가 200이고 Vercel 운영 사이트의 `/v1/auth/options`가 `public_signup: true`를 반환하는지 확인한다. 기존 서비스에서 Blueprint 변경이 자동으로 동기화되지 않으면 승인된 배포 절차로 해당 설정을 적용한다.
- Supabase 프로젝트 팀에 속하지 않는 별도 이메일 두 개로 확인 메일 수신, 로그인, 개인 작업실 생성을 검증한다. 초대 전 팀이 보이지 않고, 소유자가 발급한 코드는 지정 계정만 한 번 사용할 수 있는지 확인한다. 팀 가입 후에도 프로젝트 권한은 별도로 확인한다.
