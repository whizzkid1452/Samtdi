package collaboration

import (
	"errors"
	"strings"
	"testing"
)

func TestMaintenanceConnectionError(t *testing.T) {
	tests := []struct {
		name string
		input string
		want string
	}{
		{"password", "FATAL: password authentication failed (SQLSTATE 28P01)", "database password rejected"},
		{"tenant", "FATAL: Tenant or user not found", "pooler tenant or database role not found"},
		{"tls", "tls: failed to verify certificate: x509: certificate signed by unknown authority", "TLS certificate or handshake verification failed"},
		{"dns", "lookup db.example.invalid: no such host", "database DNS lookup failed"},
		{"timeout", "context deadline exceeded", "database connection timed out"},
		{"unknown", "unexpected error", "unclassified connection failure"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := errors.New("postgresql://role:dummy-secret@db.example.invalid/postgres: " + test.input)
			got := maintenanceConnectionError(source).Error()
			if got != "maintenance database connection failed: "+test.want {
				t.Fatalf("unexpected error category: %s", got)
			}
			if strings.Contains(got, "dummy-secret") || strings.Contains(got, "db.example.invalid") {
				t.Fatal("connection details must not be logged")
			}
		})
	}
}
