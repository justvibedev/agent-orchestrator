package controllers_test

import (
	"io"
	"net/http"
	"net/http/httptest"
)

// loopbackRequest is httptest.NewRequest with the daemon's real client Host:
// httptest defaults to example.com, which the loopback Host allowlist refuses.
// An explicit absolute-URL host is left untouched.
func loopbackRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	if req.Host == "example.com" {
		req.Host = "127.0.0.1:3001"
	}
	return req
}
