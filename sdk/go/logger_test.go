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
