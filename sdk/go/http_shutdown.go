package nextloggers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"time"
)

// HTTPShutdownServer is the subset of http.Server used by the coordinated
// serve-and-shutdown helper. Keeping it as an interface makes lifecycle behavior
// testable without binding callers to a concrete server implementation.
type HTTPShutdownServer interface {
	ShutdownServer
	Serve(net.Listener) error
}

// HTTPShutdownOptions adapts HTTP server lifecycle concerns to the shared
// shutdown coordinator. GracePeriod bounds graceful drain and force cleanup.
type HTTPShutdownOptions struct {
	GracePeriod time.Duration
	Interactive *bool
	Stdin       interface{ Read([]byte) (int, error) }

	DisableStdinEOF bool
	SignalChannel   <-chan os.Signal
	EOFChannel      <-chan struct{}

	BeforeGraceful func(context.Context) error
	Flush          func(context.Context) error
	AfterGraceful  func(context.Context) error
	ForceClose     func() error
	Observer       func(ShutdownEvent)
}

// ServeHTTPWithShutdown runs Serve while the shared shutdown coordinator owns
// graceful/forced termination. It waits for the Serve goroutine to exit after
// shutdown so callers never observe a completed lifecycle while the listener is
// still active.
func ServeHTTPWithShutdown(
	parent context.Context,
	server HTTPShutdownServer,
	listener net.Listener,
	options HTTPShutdownOptions,
) error {
	if server == nil {
		return errors.New("nextloggers: HTTP shutdown server is nil")
	}
	if listener == nil {
		return errors.New("nextloggers: HTTP listener is nil")
	}
	if parent == nil {
		parent = context.Background()
	}

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	shutdownDone := make(chan ShutdownResult, 1)
	go func() {
		shutdownDone <- RunGracefulShutdown(parent, server, ShutdownOptions{
			Timeout:         options.GracePeriod,
			Interactive:     options.Interactive,
			Stdin:           options.Stdin,
			DisableStdinEOF: options.DisableStdinEOF,
			SignalChannel:   options.SignalChannel,
			EOFChannel:      options.EOFChannel,
			BeforeGraceful: func(ctx context.Context, _ ShutdownCause) error {
				if options.BeforeGraceful == nil {
					return nil
				}
				return options.BeforeGraceful(ctx)
			},
			Flush: func(ctx context.Context, _ ShutdownCause) error {
				if options.Flush == nil {
					return nil
				}
				return options.Flush(ctx)
			},
			AfterGraceful: func(ctx context.Context, _ ShutdownCause) error {
				if options.AfterGraceful == nil {
					return nil
				}
				return options.AfterGraceful(ctx)
			},
			Force: func(_ ShutdownCause) error {
				if options.ForceClose == nil {
					return nil
				}
				return options.ForceClose()
			},
			Log: options.Observer,
		})
	}()

	select {
	case serveErr := <-serveDone:
		if ignorableServerCloseError(serveErr) {
			return nil
		}
		return serveErr
	case result := <-shutdownDone:
		serveErr := <-serveDone
		if ignorableServerCloseError(serveErr) {
			serveErr = nil
		}
		return errors.Join(result.Err, serveErr)
	}
}

// LoggerShutdownObserver is the HTTP-oriented spelling retained by the public
// lifecycle docs. The underlying logger observer remains shared with the generic
// shutdown coordinator.
func LoggerShutdownObserver(logger *Logger) func(ShutdownEvent) {
	return LoggerShutdownLog(logger)
}

var _ HTTPShutdownServer = (*http.Server)(nil)
