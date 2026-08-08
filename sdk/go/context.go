package nextloggers

import (
	"context"
	"strings"
)

type logContextKey struct{}

// LogContext is immutable-by-convention request/goroutine context copied into
// each event at creation time. It is safe to capture and re-enter in detached work.
type LogContext struct {
	Fields       map[string]any
	LoggedInUser map[string]any
	Users        []map[string]any
	TraceID      string
	TraceIDs     []string
	RoutineID    string
	Tags         []string
	Context      []any
	Meta         []any
}

func cloneLogContext(source LogContext) LogContext {
	users := make([]map[string]any, 0, len(source.Users))
	for _, user := range source.Users {
		users = append(users, cloneMap(user))
	}
	return LogContext{
		Fields:       cloneMap(source.Fields),
		LoggedInUser: cloneMap(source.LoggedInUser),
		Users:        users,
		TraceID:      source.TraceID,
		TraceIDs:     append([]string(nil), source.TraceIDs...),
		RoutineID:    source.RoutineID,
		Tags:         append([]string(nil), source.Tags...),
		Context:      append([]any(nil), source.Context...),
		Meta:         append([]any(nil), source.Meta...),
	}
}

// MergeLogContext overlays patch onto base without mutating either value.
func MergeLogContext(base, patch LogContext) LogContext {
	merged := cloneLogContext(base)
	for key, value := range patch.Fields {
		merged.Fields[key] = value
	}
	for key, value := range patch.LoggedInUser {
		merged.LoggedInUser[key] = value
	}
	for _, user := range patch.Users {
		merged.Users = append(merged.Users, cloneMap(user))
	}
	if value := strings.TrimSpace(patch.TraceID); value != "" {
		merged.TraceID = value
		merged.TraceIDs = appendUnique(merged.TraceIDs, value)
	}
	for _, traceID := range patch.TraceIDs {
		if value := strings.TrimSpace(traceID); value != "" {
			merged.TraceIDs = appendUnique(merged.TraceIDs, value)
		}
	}
	if patch.RoutineID != "" {
		merged.RoutineID = patch.RoutineID
	}
	for _, tag := range patch.Tags {
		if value := strings.TrimSpace(tag); value != "" {
			merged.Tags = appendUnique(merged.Tags, value)
		}
	}
	merged.Context = append(merged.Context, patch.Context...)
	merged.Meta = append(merged.Meta, patch.Meta...)
	return merged
}

// WithLogContext returns a child context containing a defensive snapshot.
func WithLogContext(parent context.Context, value LogContext) context.Context {
	if parent == nil {
		parent = context.Background()
	}
	if current, ok := LogContextFrom(parent); ok {
		value = MergeLogContext(current, value)
	}
	return context.WithValue(parent, logContextKey{}, cloneLogContext(value))
}

// BackgroundLogContext is shorthand for WithLogContext(context.Background(), value).
func BackgroundLogContext(value LogContext) context.Context {
	return WithLogContext(context.Background(), value)
}

// LogContextFrom returns a defensive copy of the current request context.
func LogContextFrom(ctx context.Context) (LogContext, bool) {
	if ctx == nil {
		return LogContext{}, false
	}
	value, ok := ctx.Value(logContextKey{}).(LogContext)
	if !ok {
		return LogContext{}, false
	}
	return cloneLogContext(value), true
}

// CaptureLogContext snapshots the ambient value for a queue or new goroutine.
func CaptureLogContext(ctx context.Context) LogContext {
	value, _ := LogContextFrom(ctx)
	return value
}

// WithCapturedLogContext re-enters a previously captured value under parent.
func WithCapturedLogContext(parent context.Context, captured LogContext) context.Context {
	return WithLogContext(parent, captured)
}

// ApplyLogContext copies context data into an Event. Later context mutation
// cannot change an already-created record.
func ApplyLogContext(ctx context.Context, event *Event) *Event {
	if event == nil {
		return nil
	}
	value, ok := LogContextFrom(ctx)
	if !ok {
		return event
	}
	for key, field := range value.Fields {
		event.Fields[key] = field
	}
	for key, field := range value.LoggedInUser {
		event.LoggedInUser[key] = field
	}
	for _, user := range value.Users {
		event.Users = append(event.Users, cloneMap(user))
	}
	if value.TraceID != "" {
		event.TraceID = value.TraceID
		event.TraceIDs = appendUnique(event.TraceIDs, value.TraceID)
	}
	for _, traceID := range value.TraceIDs {
		event.TraceIDs = appendUnique(event.TraceIDs, traceID)
	}
	event.RoutineID = value.RoutineID
	for _, tag := range value.Tags {
		event.Tags = appendUnique(event.Tags, tag)
	}
	event.Context = append(event.Context, value.Context...)
	event.Meta = append(event.Meta, value.Meta...)
	return event
}

func (logger *Logger) TraceContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Trace(values...))
}
func (logger *Logger) DebugContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Debug(values...))
}
func (logger *Logger) InfoContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Info(values...))
}
func (logger *Logger) WarnContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Warn(values...))
}
func (logger *Logger) ErrorContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Error(values...))
}
func (logger *Logger) FatalContext(ctx context.Context, values ...any) *Event {
	return ApplyLogContext(ctx, logger.Fatal(values...))
}
