package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

type User struct {
	TenantID string
	Username string
	Role     string
}

func hashPassword(salt, password string) string {
	h := sha256.Sum256([]byte(salt + ":" + password))
	return hex.EncodeToString(h[:])
}

func newSalt() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Store) CreateUser(ctx context.Context, tenantID, username, password, role string) error {
	salt := newSalt()
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.users (tenant_id,username,salt,password_hash,role,created_at) VALUES (?,?,?,?,?,?)",
		tenantID, username, salt, hashPassword(salt, password), role, time.Now().UTC())
	return err
}

// Authenticate verifies credentials and returns the user's tenant + role.
func (s *Store) Authenticate(ctx context.Context, username, password string) (User, bool, error) {
	var (
		tenant, salt, hash, role string
	)
	row := s.db.QueryRowContext(ctx, `
SELECT tenant_id, argMax(salt, created_at), argMax(password_hash, created_at), argMax(role, created_at)
FROM apm.users WHERE username = ? GROUP BY tenant_id LIMIT 1`, username)
	if err := row.Scan(&tenant, &salt, &hash, &role); err != nil {
		return User{}, false, nil // not found → not an error, just unauthenticated
	}
	if hash == "" || hashPassword(salt, password) != hash {
		return User{}, false, nil
	}
	return User{TenantID: tenant, Username: username, Role: role}, true, nil
}

func (s *Store) CountUsers(ctx context.Context) (uint64, error) {
	var n uint64
	err := s.db.QueryRowContext(ctx, "SELECT count(DISTINCT username) FROM apm.users").Scan(&n)
	return n, err
}

// SeedDefaultUsers creates admin/viewer accounts on first boot so the console is
// usable out of the box (demo credentials).
func (s *Store) SeedDefaultUsers(ctx context.Context) error {
	n, err := s.CountUsers(ctx)
	if err != nil || n > 0 {
		return err
	}
	if err := s.CreateUser(ctx, "default", "admin", "admin", "admin"); err != nil {
		return err
	}
	return s.CreateUser(ctx, "default", "viewer", "viewer", "viewer")
}
