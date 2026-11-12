export default function Home() {
  return (
    <main className="login">
      <div className="login-content">
        <p className="brand">사맛디</p>
        <h1>음악을 함께 완성하는 공간</h1>
        <p className="muted">초대받은 프로젝트에 로그인해 작업을 이어가세요.</p>
        <a className="button primary" href="/v1/auth/login">로그인</a>
      </div>
    </main>
  );
}
