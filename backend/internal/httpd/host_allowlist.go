package httpd

import (
	"net"
	"net/http"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/requestscope"
)

// hostAllowlistMiddleware rejects any request on the loopback listener whose
// Host header does not name the loopback interface. This is the DNS-rebinding
// boundary: a page served from http://attacker.example:3001 after the name is
// re-resolved to 127.0.0.1 is same-origin, so its GETs carry neither Origin
// nor Sec-Fetch-Site (browsers send fetch metadata only to trustworthy URLs)
// and would otherwise pass corsMiddleware as a native client. The attacker
// cannot forge the Host header, so refusing every non-loopback name closes
// that read path for all REST, SSE, and WebSocket routes, before any handler.
//
// Allowed: 127.0.0.1, localhost, and [::1] (any port, since the router does
// not know the bound port and the hostname is what an attacker cannot
// control), plus the <label>.<id>.localhost preview/artifact hosts.
// Requests that arrived through the LAN listener are exempt: they are marked
// by requestscope and authenticated by bearer auth, and their Host is a LAN
// address or tunnel name by design.
func hostAllowlistMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if requestscope.IsLAN(r.Context()) || loopbackHostAllowed(r.Host) {
				next.ServeHTTP(w, r)
				return
			}
			envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "HOST_FORBIDDEN",
				"Host is not allowed to access this daemon", nil)
		})
	}
}

func loopbackHostAllowed(hostport string) bool {
	if isPreviewHost(hostport) {
		return true
	}
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	} else {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	switch host {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}
