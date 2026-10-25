package httpd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/requestscope"
	previewutil "github.com/aoagents/agent-orchestrator/backend/internal/preview"
)

func hostForbidden(t *testing.T, rec *httptest.ResponseRecorder) bool {
	t.Helper()
	if rec.Code != http.StatusForbidden {
		return false
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return body.Code == "HOST_FORBIDDEN"
}

func TestHostAllowlistRejectsReboundHostsBeforeHandlers(t *testing.T) {
	router := newTestRouter(config.Config{AllowedOrigins: []string{"app://renderer"}}, nil, nil)
	hosts := []string{
		"attacker.example:3001",
		"attacker.example",
		"127.0.0.1.attacker.example:3001",
		"localhost.attacker.example:3001",
		"host.docker.internal:3001",
		"192.168.1.20:3001",
		"10.0.0.5",
		"0.0.0.0:3001",
		"[::ffff:127.0.0.1]:3001",
		"",
	}
	paths := []string{
		"/api/v1/settings",
		"/api/v1/sessions",
		"/link-preview?url=http://169.254.169.254/",
		"/api/v1/link-preview?url=http://169.254.169.254/",
		"/healthz",
		"/mux",
	}
	for _, host := range hosts {
		for _, path := range paths {
			// A rebound same-origin GET carries no Origin and no Sec-Fetch-Site.
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Host = host
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if !hostForbidden(t, rec) {
				t.Errorf("Host %q GET %s = %d %s, want 403 HOST_FORBIDDEN", host, path, rec.Code, rec.Body.String())
			}
		}
	}
}

func TestHostAllowlistRejectsReboundHostOnPreflight(t *testing.T) {
	router := newTestRouter(config.Config{AllowedOrigins: []string{"app://renderer"}}, nil, nil)
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/settings", nil)
	req.Host = "attacker.example:3001"
	req.Header.Set("Origin", "app://renderer")
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if !hostForbidden(t, rec) {
		t.Fatalf("preflight with rebound Host = %d, want 403 HOST_FORBIDDEN", rec.Code)
	}
}

func TestHostAllowlistAcceptsLegitimateClientHosts(t *testing.T) {
	router := newTestRouter(config.Config{AllowedOrigins: []string{"app://renderer"}}, nil, nil)
	previewHost, err := previewutil.FileURL("http://127.0.0.1:3001", domain.SessionID("ao-1"), "index.html")
	if err != nil {
		t.Fatal(err)
	}
	previewHost = strings.TrimPrefix(previewHost, "http://")
	previewHost = previewHost[:strings.Index(previewHost, "/")]

	cases := []struct {
		name, host, origin string
	}{
		{"cli and electron main (127.0.0.1)", "127.0.0.1:3001", ""},
		{"electron renderer app://renderer", "127.0.0.1:41234", "app://renderer"},
		{"localhost", "localhost:3001", ""},
		{"ipv6 loopback", "[::1]:3001", ""},
		{"no port", "127.0.0.1", ""},
		{"uppercase localhost", "LOCALHOST:3001", ""},
		{"preview host", previewHost, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			// Preview hosts are routed to the preview handler (404 without a
			// registered preview); the allowlist itself must not refuse them.
			if hostForbidden(t, rec) {
				t.Fatalf("Host %q refused by allowlist: %s", tc.host, rec.Body.String())
			}
			if !strings.Contains(tc.name, "preview") && rec.Code != http.StatusOK {
				t.Fatalf("Host %q = %d %s, want 200", tc.host, rec.Code, rec.Body.String())
			}
		})
	}
}

// A real HTTP client addressing the bound loopback listener, exactly as the
// CLI, hooks and the Electron main process do, sends Host 127.0.0.1:<port>.
func TestHostAllowlistAcceptsRealLoopbackClient(t *testing.T) {
	srv := httptest.NewServer(newTestRouter(config.Config{}, nil, nil))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", resp.StatusCode, body)
	}
}

func TestHostAllowlistExemptsLANScopedRequests(t *testing.T) {
	router := newTestRouter(config.Config{}, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Host = "192.168.1.20:3002"
	req = req.WithContext(requestscope.WithLAN(req.Context()))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if hostForbidden(t, rec) {
		t.Fatalf("LAN-scoped request was refused by the loopback Host allowlist: %s", rec.Body.String())
	}
}
