package nextloggers

// adversarialSpan is intentionally a recording span so the adversarial suite
// exercises RecordError, SetStatus, and End behavior instead of noop fallback.
func (span *adversarialSpan) IsRecording() bool { return true }
