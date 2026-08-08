//! Runtime-independent scoped logging context.
//!
//! `ContextualFuture` installs the captured frame for each poll, which gives
//! task-local semantics on Tokio, async-std, smol, and custom executors without
//! tying the logger to a global runtime or OpenTelemetry context manager.

use crate::{Event, JsonObject, LogLevel, Logger, Value};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};

thread_local! {
    static LOG_CONTEXT_STACK: RefCell<Vec<LogContext>> = RefCell::new(Vec::new());
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct LogContext {
    #[serde(default, skip_serializing_if = "JsonObject::is_empty")]
    pub fields: JsonObject,
    #[serde(
        rename = "loggedInUser",
        default,
        skip_serializing_if = "JsonObject::is_empty"
    )]
    pub logged_in_user: JsonObject,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub users: Vec<JsonObject>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(rename = "traceIds", default, skip_serializing_if = "Vec::is_empty")]
    pub trace_ids: Vec<String>,
    #[serde(rename = "routineId", skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub meta: Vec<Value>,
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

impl LogContext {
    pub fn merge(mut self, patch: LogContext) -> Self {
        self.fields.extend(patch.fields);
        self.logged_in_user.extend(patch.logged_in_user);
        self.users.extend(patch.users);
        if let Some(trace_id) = patch.trace_id {
            let trace_id = trace_id.trim().to_string();
            if !trace_id.is_empty() {
                self.trace_id = Some(trace_id.clone());
                push_unique(&mut self.trace_ids, trace_id);
            }
        }
        for trace_id in patch.trace_ids {
            push_unique(&mut self.trace_ids, trace_id.trim().to_string());
        }
        if patch.routine_id.is_some() {
            self.routine_id = patch.routine_id;
        }
        for tag in patch.tags {
            push_unique(&mut self.tags, tag.trim().to_string());
        }
        self.context.extend(patch.context);
        self.meta.extend(patch.meta);
        self
    }

    pub fn apply(self, mut event: Event) -> Event {
        event = event.add_fields(self.fields);
        if !self.logged_in_user.is_empty() {
            event = event.add_logged_in_user_info(self.logged_in_user);
        }
        for user in self.users {
            event = event.add_user_info(user);
        }
        if let Some(trace_id) = self.trace_id {
            event = event.add_trace(trace_id, true);
        }
        for trace_id in self.trace_ids {
            event = event.add_trace(trace_id, false);
        }
        if let Some(routine_id) = self.routine_id {
            event = event.add_routine_id(routine_id);
        }
        event = event.add_tags(self.tags);
        for value in self.context {
            event = event.add_context(value);
        }
        for value in self.meta {
            event = event.add_meta(value);
        }
        event
    }
}

struct ContextGuard;

impl Drop for ContextGuard {
    fn drop(&mut self) {
        LOG_CONTEXT_STACK.with(|stack| {
            stack.borrow_mut().pop();
        });
    }
}

/// Runs a synchronous callback inside a nested context frame.
pub fn with_log_context<T>(context: LogContext, callback: impl FnOnce() -> T) -> T {
    LOG_CONTEXT_STACK.with(|stack| stack.borrow_mut().push(context));
    let _guard = ContextGuard;
    callback()
}

pub fn current_log_context() -> Option<LogContext> {
    LOG_CONTEXT_STACK.with(|stack| stack.borrow().last().cloned())
}

/// Captures the current frame for a queue, callback, or spawned task.
pub fn capture_log_context() -> Option<LogContext> {
    current_log_context()
}

pub fn with_captured_log_context<T>(
    captured: Option<LogContext>,
    callback: impl FnOnce() -> T,
) -> T {
    match captured {
        Some(context) => with_log_context(context, callback),
        None => callback(),
    }
}

/// A future that installs one context frame for every poll.
#[must_use = "futures do nothing unless polled or awaited"]
pub struct ContextualFuture<F> {
    context: LogContext,
    future: F,
}

impl<F> ContextualFuture<F> {
    pub fn new(context: LogContext, future: F) -> Self {
        Self { context, future }
    }
}

impl<F: Future> Future for ContextualFuture<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        // SAFETY: once ContextualFuture is pinned, `future` is never moved. We
        // only create a pinned projection for the duration of this poll.
        let this = unsafe { self.get_unchecked_mut() };
        let context = this.context.clone();
        with_log_context(context, || {
            // SAFETY: explained above; the field stays at the same address.
            unsafe { Pin::new_unchecked(&mut this.future) }.poll(cx)
        })
    }
}

pub fn contextualize_future<F: Future>(
    context: LogContext,
    future: F,
) -> ContextualFuture<F> {
    ContextualFuture::new(context, future)
}

pub trait LoggerContextExt {
    fn event_context(&self, level: LogLevel, values: Vec<Value>) -> Event;
    fn trace_context(&self, values: Vec<Value>) -> Event;
    fn debug_context(&self, values: Vec<Value>) -> Event;
    fn info_context(&self, values: Vec<Value>) -> Event;
    fn warn_context(&self, values: Vec<Value>) -> Event;
    fn error_context(&self, values: Vec<Value>) -> Event;
    fn fatal_context(&self, values: Vec<Value>) -> Event;
}

impl LoggerContextExt for Logger {
    fn event_context(&self, level: LogLevel, values: Vec<Value>) -> Event {
        let event = match level {
            LogLevel::Trace => self.trace(values),
            LogLevel::Debug => self.debug(values),
            LogLevel::Info => self.info(values),
            LogLevel::Warn => self.warn(values),
            LogLevel::Error => self.error(values),
            LogLevel::Fatal => self.fatal(values),
        };
        match current_log_context() {
            Some(context) => context.apply(event),
            None => event,
        }
    }

    fn trace_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Trace, values)
    }
    fn debug_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Debug, values)
    }
    fn info_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Info, values)
    }
    fn warn_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Warn, values)
    }
    fn error_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Error, values)
    }
    fn fatal_context(&self, values: Vec<Value>) -> Event {
        self.event_context(LogLevel::Fatal, values)
    }
}
