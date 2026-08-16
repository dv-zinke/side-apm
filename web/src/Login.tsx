import { useState } from "react";
import { login, useAuth } from "./auth";

export function Login() {
  const { setAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      setAuth(await login(username, password));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "로그인에 실패했어요");
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark">◆</span> APM Console</div>
        <h1 className="login-title">로그인</h1>
        <p className="login-sub">계정으로 콘솔에 접속하세요.</p>
        <label className="onboard-field"><span className="field-label">아이디</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </label>
        <label className="onboard-field"><span className="field-label">비밀번호</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <div className="form-err" role="alert">{err}</div>}
        <button type="submit" className="btn btn-primary login-btn" disabled={busy || !username || !password}>
          {busy ? "확인 중…" : "로그인"}
        </button>
        <p className="login-hint">데모 계정 — 관리자 <b>admin / admin</b> · 뷰어 <b>viewer / viewer</b></p>
      </form>
    </div>
  );
}
