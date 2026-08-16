package query

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type authCtxKey struct{}

type Principal struct {
	Tenant string `json:"t"`
	User   string `json:"u"`
	Role   string `json:"r"`
	Exp    int64  `json:"e"`
}

func authSecret() []byte {
	if s := os.Getenv("APM_AUTH_SECRET"); s != "" {
		return []byte(s)
	}
	return []byte("apm-dev-secret-change-me")
}

func signToken(p Principal) string {
	body, _ := json.Marshal(p)
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, authSecret())
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

func verifyToken(tok string) (Principal, bool) {
	parts := strings.SplitN(tok, ".", 2)
	if len(parts) != 2 {
		return Principal{}, false
	}
	mac := hmac.New(sha256.New, authSecret())
	mac.Write([]byte(parts[0]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[1])) {
		return Principal{}, false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Principal{}, false
	}
	var p Principal
	if err := json.Unmarshal(body, &p); err != nil {
		return Principal{}, false
	}
	if p.Exp > 0 && time.Now().Unix() > p.Exp {
		return Principal{}, false
	}
	return p, true
}

func principalOf(r *http.Request) (Principal, bool) {
	p, ok := r.Context().Value(authCtxKey{}).(Principal)
	return p, ok
}

// tenantOf returns the authenticated tenant, falling back to the default tenant
// (single-tenant/unauthenticated paths).
func tenantOf(r *http.Request) string {
	if p, ok := principalOf(r); ok && p.Tenant != "" {
		return p.Tenant
	}
	return defaultTenant
}

// authMiddleware validates the bearer token and enforces RBAC: unauthenticated
// requests are rejected (except the login route), and viewers can't mutate.
func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Auth disabled unless a secret/users are configured — but we always seed
		// users, so require auth. Public routes:
		if r.Method == http.MethodOptions || r.URL.Path == "/api/v1/auth/login" || r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		tok := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tok = strings.TrimPrefix(h, "Bearer ")
		}
		p, ok := verifyToken(tok)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// RBAC: viewers are read-only.
		if p.Role == "viewer" && r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "forbidden: read-only role", http.StatusForbidden)
			return
		}
		ctx := context.WithValue(r.Context(), authCtxKey{}, p)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// registerAuth adds login/whoami. The store must expose Authenticate.
func registerAuth(mux *http.ServeMux, a interface {
	Authenticate(ctx context.Context, username, password string) (storage.User, bool, error)
}) {
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, req *http.Request) {
		var in struct{ Username, Password string }
		if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		u, ok, err := a.Authenticate(req.Context(), in.Username, in.Password)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "아이디 또는 비밀번호가 올바르지 않아요", http.StatusUnauthorized)
			return
		}
		p := Principal{Tenant: u.TenantID, User: u.Username, Role: u.Role, Exp: time.Now().Add(12 * time.Hour).Unix()}
		writeJSON(w, map[string]any{"token": signToken(p), "user": u.Username, "role": u.Role, "tenant": u.TenantID})
	})

	mux.HandleFunc("GET /api/v1/auth/me", func(w http.ResponseWriter, req *http.Request) {
		p, ok := principalOf(req)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		writeJSON(w, map[string]any{"user": p.User, "role": p.Role, "tenant": p.Tenant})
	})
}
