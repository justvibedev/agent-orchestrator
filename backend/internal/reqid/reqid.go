// Package reqid reads the HTTP request id off a context.
//
// Background work deliberately detaches from the request context
// (context.Background) so a cancelled request cannot drop work that already
// happened. Reading the id before that detach keeps daemon-side logs joinable
// to the HTTP request that caused them.
package reqid

import (
	"context"

	"github.com/go-chi/chi/v5/middleware"
)

// FromContext returns the request id chi's RequestID middleware put on ctx, or
// "" when ctx is not request-scoped (daemon startup, reaper ticks, tests).
func FromContext(ctx context.Context) string { return middleware.GetReqID(ctx) }
