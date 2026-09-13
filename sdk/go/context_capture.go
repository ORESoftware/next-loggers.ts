package nextloggers

import "context"

// CaptureLogContext returns a defensive snapshot suitable for detached work.
// The zero value represents the absence of an installed log context.
func CaptureLogContext(ctx context.Context) LogContext {
	value, _ := LogContextFrom(ctx)
	return value
}

// WithCapturedLogContext installs a previously captured snapshot under the
// chosen parent without merging mutable state from a different request scope.
func WithCapturedLogContext(parent context.Context, snapshot LogContext) context.Context {
	return withLogContextSnapshot(parent, snapshot)
}
