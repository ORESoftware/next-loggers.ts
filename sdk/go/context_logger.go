package nextloggers

import "context"

// ensureContextEventState makes the zero value of Logger safe for the context
// convenience API. NewLogger already initializes unsent tracking, but callers
// may legitimately embed or construct a zero-value Logger before layering
// context onto an event.
func (logger *Logger) ensureContextEventState() {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if logger.unsent == nil {
		logger.unsent = make(map[*Event]struct{})
	}
}

func (logger *Logger) TraceContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Trace(values...).ApplyContext(ctx)
}

func (logger *Logger) DebugContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Debug(values...).ApplyContext(ctx)
}

func (logger *Logger) InfoContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Info(values...).ApplyContext(ctx)
}

func (logger *Logger) WarnContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Warn(values...).ApplyContext(ctx)
}

func (logger *Logger) ErrorContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Error(values...).ApplyContext(ctx)
}

func (logger *Logger) FatalContext(ctx context.Context, values ...any) *Event {
	logger.ensureContextEventState()
	return logger.Fatal(values...).ApplyContext(ctx)
}
