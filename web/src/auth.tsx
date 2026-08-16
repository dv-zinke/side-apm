import { createContext, useContext, useState } from "react";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";
const KEY = "apm.auth";

export type Auth = { token: string; user: string; role: string; tenant: string };

function load(): Auth | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

// A tiny auth store. The token is attached to every API request by patching
// fetch (below) so existing api.ts calls need no changes.
const AuthCtx = createContext<{ auth: Auth | null; setAuth: (a: Auth | null) => void }>({ auth: null, setAuth: () => {} });
export const useAuth = () => useContext(AuthCtx);

let currentToken: string | null = load()?.token ?? null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuthState] = useState<Auth | null>(load);
  const setAuth = (a: Auth | null) => {
    currentToken = a?.token ?? null;
    if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY);
    setAuthState(a);
  };
  return <AuthCtx.Provider value={{ auth, setAuth }}>{children}</AuthCtx.Provider>;
}

export async function login(username: string, password: string): Promise<Auth> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error((await r.text()) || "로그인 실패");
  const d = await r.json();
  return { token: d.token, user: d.user, role: d.role, tenant: d.tenant };
}

// Patch fetch once so every request carries the bearer token and a 401 clears
// the stored session (bounces back to login).
let patched = false;
export function installAuthFetch(onUnauthorized: () => void) {
  if (patched) return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (currentToken && url.includes(BASE)) {
      init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${currentToken}` } };
    }
    const res = await orig(input, init);
    if (res.status === 401 && url.includes(BASE) && !url.includes("/auth/login")) {
      currentToken = null;
      localStorage.removeItem(KEY);
      onUnauthorized();
    }
    return res;
  };
}
