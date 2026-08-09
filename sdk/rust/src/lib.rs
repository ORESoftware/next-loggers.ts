//! Polyglot structured logging and explicit OpenTelemetry context adapters.

mod logger_core {
    include!("core.rs");
}

pub use logger_core::*;

pub mod context;
pub mod span;

pub use context::{
    apply_log_context, capture_log_context, current_log_context, enter_log_context,
    merge_log_context, update_log_context, with_captured_log_context, with_log_context,
    with_log_context_async, ContextFuture, LogContext, LogContextGuard,
};
pub use span::{with_span, with_span_async, Span, Tracer, OTEL_STATUS_ERROR, OTEL_STATUS_OK};
