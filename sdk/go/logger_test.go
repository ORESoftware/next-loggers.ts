package nextloggers

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func decodedJSON(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestSharedConformanceRecord(t *testing.T) {
	fixtureData, err := os.ReadFile("../../contracts/fixtures/conformance-record.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected any
	if err := json.Unmarshal(fixtureData, &expected); err != nil {
		t.Fatal(err)
	}

	transport := &MemoryTransport{}
	logger := NewLogger(Options{
		AppName:    "payments",
		Name:       "audit",
		Runtime:    "contract-test",
		Fields:     map[string]any{"environment": "test"},
		Transports: []Transport{transport},
		Console:    false,
		IDFactory:  func() string { return "contract-record-1" },
		Clock:      func() string { return "2026-01-02T03:04:05.000Z" },
	})

	event := logger.Error("payment failed", 42).
		AddFields(map[string]any{"orderId": "order-42"}).
		AddLoggedInUserID("user-1").
		AddUserInfo(map[string]any{"id": "user-2"}).
		AddTrace("trace-1").
		AddTrace("trace-2").
		AddRoutineID("charge-card").
		AddTags("payments", "critical", "payments").
		AddContext(map[string]any{"attempt": 2}).
		AddMeta(map[string]any{"source": "fixture"})

	if err := event.Send(); err != nil {
		t.Fatal(err)
	}
	if err := event.Send(); err != nil {
		t.Fatal(err)
	}
	if len(transport.Records) != 1 {
		t.Fatalf("expected one idempotent delivery, got %d", len(transport.Records))
	}
	if actual := decodedJSON(t, transport.Records[0]); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("record mismatch\nactual: %#v\nexpected: %#v", actual, expected)
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownRecoversUnsentEvents(t *testing.T) {
	transport := &MemoryTransport{}
	logger := NewLogger(Options{
		Transports: []Transport{transport},
		Console:    false,
	})
	logger.Warn("created but not explicitly sent")
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	if len(transport.Records) != 1 {
		t.Fatalf("expected recovered record, got %d", len(transport.Records))
	}
	if len(transport.ExitRecords) != 1 {
		t.Fatalf("expected one exit record, got %d", len(transport.ExitRecords))
	}
	if !transport.Closed {
		t.Fatal("transport was not closed")
	}
}

type AuditEvent struct {
	*Event
}

func (event *AuditEvent) WithActor(actor string) *AuditEvent {
	event.AddFields(map[string]any{"actor": actor})
	return event
}

func TestLevelsSendFalseAndEmbedding(t *testing.T) {
	transport := &MemoryTransport{}
	logger := NewLogger(Options{
		MaxLevel:   Warn,
		Transports: []Transport{transport},
		Console:    false,
	})
	if err := logger.Info("filtered").Send(); err != nil {
		t.Fatal(err)
	}
	if err := (&AuditEvent{logger.Error("local")}).WithActor("user-9").SendWithStore(false); err != nil {
		t.Fatal(err)
	}
	if err := (&AuditEvent{logger.Fatal("stored")}).WithActor("user-9").Send(); err != nil {
		t.Fatal(err)
	}

	if len(transport.Records) != 1 {
		t.Fatalf("expected one stored record, got %d", len(transport.Records))
	}
	if transport.Records[0].Level != Fatal {
		t.Fatalf("expected FATAL, got %s", transport.Records[0].Level)
	}
	if transport.Records[0].Fields["actor"] != "user-9" {
		t.Fatal("embedded event did not add actor")
	}
}

func TestExplicitOpenTelemetryAndSupabaseTransports(t *testing.T) {
	otel := make([]OpenTelemetryLogRecord, 0, 1)
	supabase := make([]LogRecord, 0, 1)
	logger := NewLogger(Options{
		AppName: "checkout",
		Runtime: "go",
		Transports: []Transport{
			NewOpenTelemetryTransport(func(record OpenTelemetryLogRecord) error {
				otel = append(otel, record)
				return nil
			}),
			NewSupabaseTransport(func(record LogRecord) error {
				supabase = append(supabase, record)
				return nil
			}),
		},
		Console:   false,
		IDFactory: func() string { return "otel-record-1" },
		Clock:     func() string { return "2026-01-02T03:04:05.000Z" },
	})

	err := logger.Error("payment failed").
		AddTrace("0123456789abcdef0123456789abcdef").
		AddFields(map[string]any{
			"otel.span_id": "0123456789abcdef",
			"region":       "us-east-1",
		}).
		Send()
	if err != nil {
		t.Fatal(err)
	}

	if len(otel) != 1 || len(supabase) != 1 {
		t.Fatalf("expected one OTEL and Supabase delivery, got %d and %d", len(otel), len(supabase))
	}
	if otel[0].SeverityText != "ERROR" || otel[0].SeverityNumber != 17 {
		t.Fatalf("unexpected OTEL severity: %#v", otel[0])
	}
	if otel[0].Attributes["trace.id"] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("trace correlation missing: %#v", otel[0].Attributes)
	}
	if otel[0].Attributes["service.name"] != "checkout" {
		t.Fatalf("service name missing: %#v", otel[0].Attributes)
	}
	if supabase[0].Schema != Schema || supabase[0].Message != "payment failed" {
		t.Fatalf("unexpected Supabase record: %#v", supabase[0])
	}
}

func TestPerEventOpenTelemetryRouting(t *testing.T) {
	otelDefault := false
	otel := make([]OpenTelemetryLogRecord, 0, 2)
	regular := &MemoryTransport{}
	logger := NewLogger(Options{
		Otel: &otelDefault,
		Transports: []Transport{
			NewOpenTelemetryTransport(func(record OpenTelemetryLogRecord) error {
				otel = append(otel, record)
				return nil
			}),
			regular,
		},
		Console: false,
	})

	defaultOff := logger.Info("default-off")
	if defaultOff.IsOtelEnabled(logger.IsOtelEnabled()) {
		t.Fatal("logger default should keep OTEL off")
	}
	for _, event := range []*Event{
		defaultOff,
		logger.Info("forced-on").UseOtel(),
		logger.Info("reset-off").UseOtel().ResetOtel(),
	} {
		if err := event.Send(); err != nil {
			t.Fatal(err)
		}
	}
	logger.UseOtel()
	if err := logger.Warn("forced-off").NotOtel().Send(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Info("logger-on").WithOtel(true).Send(); err != nil {
		t.Fatal(err)
	}

	if len(otel) != 2 || otel[0].Body != "forced-on" || otel[1].Body != "logger-on" {
		t.Fatalf("unexpected OTEL routing: %#v", otel)
	}
	wantRegular := []string{"default-off", "forced-on", "reset-off", "forced-off", "logger-on"}
	if len(regular.Records) != len(wantRegular) {
		t.Fatalf("regular transport delivery count: got %d, want %d", len(regular.Records), len(wantRegular))
	}
	for index, message := range wantRegular {
		if regular.Records[index].Message != message {
			t.Fatalf("regular transport missed %q: %#v", message, regular.Records)
		}
		}
}

func TestPerEventOtelRouting(t *testing.T) {
	var otel []OpenTelemetryLogRecord
	memory := &MemoryTransport{}
	logger := NewLogger(Options{
		AppName: "checkout",
		Transports: []Transport{
			NewOpenTelemetryTransport(func(record OpenTelemetryLogRecord) error {
				otel = append(otel, record)
				return nil
			}),
			memory,
		},
		Console: false,
	})

	if err := logger.Info("default on").Send(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Warn("opted out").NotOtel().Send(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Error("opted in").UseOtel().Send(); err != nil {
		t.Fatal(err)
	}
	if len(otel) != 2 || otel[0].Body != "default on" || otel[1].Body != "opted in" {
		t.Fatalf("unexpected OTEL deliveries: %#v", otel)
	}
	if len(memory.Records) != 3 {
		t.Fatalf("non-OTEL transports must receive every record, got %d", len(memory.Records))
	}

	disabled := false
	optIn := NewLogger(Options{
		AppName: "checkout",
		Otel:    &disabled,
		Transports: []Transport{NewOpenTelemetryTransport(func(record OpenTelemetryLogRecord) error {
			otel = append(otel, record)
			return nil
		})},
		Console: false,
	})
	before := len(otel)
	if err := optIn.Info("skipped").Send(); err != nil {
		t.Fatal(err)
	}
	if len(otel) != before {
		t.Fatalf("otel:false must make OpenTelemetry opt-in, got %#v", otel[before:])
	}
	if err := optIn.Info("selected").UseOtel().Send(); err != nil {
		t.Fatal(err)
	}
	if len(otel) != before+1 || otel[before].Body != "selected" {
		t.Fatalf("UseOtel must override the logger default: %#v", otel[before:])
	}
	optIn.UseOtel()
	if err := optIn.Info("default flipped").Send(); err != nil {
		t.Fatal(err)
	}
	if len(otel) != before+2 {
		t.Fatalf("logger.UseOtel must flip the default: %#v", otel[before:])
	}
	if err := optIn.Info("reset follows default").UseOtel().ResetOtel().Send(); err != nil {
		t.Fatal(err)
	}
	if len(otel) != before+3 {
		t.Fatalf("ResetOtel must fall back to the logger default: %#v", otel[before:])
		}
}
