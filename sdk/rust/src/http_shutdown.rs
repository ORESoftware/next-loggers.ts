//! Runtime-neutral HTTP admission and bounded graceful-shutdown helpers.
//!
//! The application/runtime owns signal installation, listener shutdown, in-flight
//! request cancellation, connection force-close, and OpenTelemetry/logger flush.
//! This module owns the shared policy and state:
//!
//! - the first termination request starts a bounded drain;
//! - new HTTP requests are rejected immediately once draining starts;
//! - the default drain deadline is five seconds;
//! - after the deadline, runtimes should force-close remaining work;
//! - in an interactive terminal, SIGINT starts draining and prints a Ctrl-D hint;
//! - stdin EOF (Ctrl-D) forces completion immediately while draining.

use crate::shutdown::{
    ShutdownCoordinator, ShutdownDecision, ShutdownObserver, ShutdownPhase, ShutdownTrigger,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_HTTP_GRACE_PERIOD: Duration = Duration::from_secs(5);
pub const SHUTDOWN_HTTP_STATUS: u16 = 429;
pub const SHUTDOWN_HTTP_BODY: &str = "server is shutting down; retry shortly";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpShutdownRejection {
    /// HTTP 429 is deliberately used for the shared contract because callers
    /// requested a 4xx admission response while the process is draining.
    pub status_code: u16,
    /// Value for the HTTP `Retry-After` header, in whole seconds.
    pub retry_after_seconds: u64,
    /// HTTP/1.x adapters should emit `Connection: close` when this is true.
    pub connection_close: bool,
    pub body: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HttpAdmission {
    Accept,
    Reject(HttpShutdownRejection),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownSignalOutcome {
    pub decision: ShutdownDecision,
    /// Interactive adapters should write this warning to stderr/console.
    pub terminal_warning: Option<String>,
}

/// Atomic admission gate shared by HTTP/HTTPS adapters.
///
/// Keep this outside framework-specific middleware so Axum, Hyper, Actix, Warp,
/// custom TLS listeners, and reverse-proxy adapters can all share the policy.
pub struct HttpShutdownGate {
    accepting_new_requests: AtomicBool,
    drain_started_at: Mutex<Option<Instant>>,
    grace_period: Duration,
}

impl Default for HttpShutdownGate {
    fn default() -> Self {
        Self::new(DEFAULT_HTTP_GRACE_PERIOD)
    }
}

impl HttpShutdownGate {
    pub fn new(grace_period: Duration) -> Self {
        Self {
            accepting_new_requests: AtomicBool::new(true),
            drain_started_at: Mutex::new(None),
            grace_period,
        }
    }

    pub fn grace_period(&self) -> Duration {
        self.grace_period
    }

    pub fn accepting_new_requests(&self) -> bool {
        self.accepting_new_requests.load(Ordering::Acquire)
    }

    /// Atomically stops new admissions and starts the grace deadline exactly once.
    /// Returns true only for the call that transitions the gate into draining.
    pub fn begin_drain(&self) -> bool {
        if self
            .accepting_new_requests
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }

        let mut started_at = self
            .drain_started_at
            .lock()
            .expect("HTTP shutdown drain clock poisoned");
        *started_at = Some(Instant::now());
        true
    }

    /// Permanently closes admission without changing an already-started deadline.
    pub fn stop_accepting(&self) {
        self.accepting_new_requests.store(false, Ordering::Release);
    }

    pub fn drain_started(&self) -> bool {
        self.drain_started_at
            .lock()
            .expect("HTTP shutdown drain clock poisoned")
            .is_some()
    }

    pub fn remaining_grace(&self) -> Option<Duration> {
        let started_at = *self
            .drain_started_at
            .lock()
            .expect("HTTP shutdown drain clock poisoned");
        started_at.map(|started| self.grace_period.saturating_sub(started.elapsed()))
    }

    pub fn deadline_expired(&self) -> bool {
        matches!(self.remaining_grace(), Some(remaining) if remaining.is_zero())
    }

    pub fn admission(&self) -> HttpAdmission {
        if self.accepting_new_requests() {
            return HttpAdmission::Accept;
        }

        let retry_after_seconds = self
            .remaining_grace()
            .unwrap_or(self.grace_period)
            .as_millis()
            .saturating_add(999)
            / 1_000;

        HttpAdmission::Reject(HttpShutdownRejection {
            status_code: SHUTDOWN_HTTP_STATUS,
            retry_after_seconds: retry_after_seconds as u64,
            connection_close: true,
            body: SHUTDOWN_HTTP_BODY,
        })
    }
}

/// Shared HTTP/HTTPS lifecycle policy. Runtime adapters translate its decisions
/// into listener shutdown, request drain, force-close, and final telemetry flush.
pub struct HttpShutdownController {
    lifecycle: ShutdownCoordinator,
    gate: HttpShutdownGate,
}

impl Default for HttpShutdownController {
    fn default() -> Self {
        Self::new(None)
    }
}

impl HttpShutdownController {
    pub fn new(observer: Option<ShutdownObserver>) -> Self {
        Self::with_grace_period(observer, DEFAULT_HTTP_GRACE_PERIOD)
    }

    pub fn with_grace_period(
        observer: Option<ShutdownObserver>,
        grace_period: Duration,
    ) -> Self {
        Self {
            lifecycle: ShutdownCoordinator::new(observer),
            gate: HttpShutdownGate::new(grace_period),
        }
    }

    pub fn phase(&self) -> ShutdownPhase {
        self.lifecycle.phase()
    }

    pub fn gate(&self) -> &HttpShutdownGate {
        &self.gate
    }

    pub fn admission(&self) -> HttpAdmission {
        self.gate.admission()
    }

    pub fn remaining_grace(&self) -> Option<Duration> {
        self.gate.remaining_grace()
    }

    pub fn deadline_expired(&self) -> bool {
        self.gate.deadline_expired()
    }

    /// Apply a process/terminal signal to the shared lifecycle policy.
    ///
    /// Interactive behavior intentionally differs from unattended service mode:
    /// SIGINT starts the drain and emits a Ctrl-D warning; another SIGINT while
    /// draining does not skip the grace period. Ctrl-D (stdin EOF) forces now.
    pub fn handle_signal(
        &self,
        trigger: ShutdownTrigger,
        interactive: bool,
    ) -> ShutdownSignalOutcome {
        let decision = match (&trigger, interactive, self.lifecycle.phase()) {
            (ShutdownTrigger::StdinEof, true, ShutdownPhase::Draining) => {
                self.lifecycle.force(trigger.clone(), true)
            }
            (ShutdownTrigger::SigInt, true, ShutdownPhase::Draining) => {
                ShutdownDecision::Ignore
            }
            (ShutdownTrigger::Timeout, _, _) => {
                self.lifecycle.force(trigger.clone(), interactive)
            }
            _ => self.lifecycle.request(trigger.clone(), interactive),
        };

        match decision {
            ShutdownDecision::Drain => {
                self.gate.begin_drain();
            }
            ShutdownDecision::Force => {
                self.gate.stop_accepting();
            }
            ShutdownDecision::Ignore => {}
        }

        let terminal_warning = if interactive && matches!(trigger, ShutdownTrigger::SigInt) {
            Some(format!(
                "graceful shutdown started: new HTTP requests are rejected; in-flight requests have at most {} ms; press Ctrl-D to force shutdown now",
                self.gate.grace_period().as_millis()
            ))
        } else {
            None
        };

        ShutdownSignalOutcome {
            decision,
            terminal_warning,
        }
    }

    /// Escalate an expired drain deadline. Runtimes should call this from their
    /// five-second timer before force-closing connections/tasks.
    pub fn force_if_deadline_expired(&self, interactive: bool) -> ShutdownDecision {
        if self.deadline_expired() {
            self.gate.stop_accepting();
            self.lifecycle.force(ShutdownTrigger::Timeout, interactive)
        } else {
            ShutdownDecision::Ignore
        }
    }

    pub fn record_error(&self, error: impl std::fmt::Display) {
        self.lifecycle.record_error(error);
    }

    /// Call only after listener/task force-close and telemetry/log flush complete.
    pub fn mark_stopped(&self, trigger: ShutdownTrigger, interactive: bool) {
        self.gate.stop_accepting();
        self.lifecycle.mark_stopped(trigger, interactive);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn first_sigint_flips_http_admission_immediately() {
        let controller = HttpShutdownController::default();
        assert_eq!(controller.admission(), HttpAdmission::Accept);

        let outcome = controller.handle_signal(ShutdownTrigger::SigInt, false);
        assert_eq!(outcome.decision, ShutdownDecision::Drain);
        assert_eq!(controller.phase(), ShutdownPhase::Draining);

        match controller.admission() {
            HttpAdmission::Reject(rejection) => {
                assert_eq!(rejection.status_code, 429);
                assert!(rejection.retry_after_seconds <= 5);
                assert!(rejection.connection_close);
            }
            HttpAdmission::Accept => panic!("draining server accepted a new request"),
        }
    }

    #[test]
    fn interactive_sigint_waits_for_ctrl_d_or_deadline() {
        let controller = HttpShutdownController::default();
        let first = controller.handle_signal(ShutdownTrigger::SigInt, true);
        assert_eq!(first.decision, ShutdownDecision::Drain);
        assert!(first.terminal_warning.is_some());

        let second = controller.handle_signal(ShutdownTrigger::SigInt, true);
        assert_eq!(second.decision, ShutdownDecision::Ignore);
        assert_eq!(controller.phase(), ShutdownPhase::Draining);

        let eof = controller.handle_signal(ShutdownTrigger::StdinEof, true);
        assert_eq!(eof.decision, ShutdownDecision::Force);
        assert_eq!(controller.phase(), ShutdownPhase::Forcing);
    }

    #[test]
    fn noninteractive_second_signal_forces() {
        let controller = HttpShutdownController::default();
        assert_eq!(
            controller
                .handle_signal(ShutdownTrigger::SigTerm, false)
                .decision,
            ShutdownDecision::Drain
        );
        assert_eq!(
            controller
                .handle_signal(ShutdownTrigger::SigTerm, false)
                .decision,
            ShutdownDecision::Force
        );
    }

    #[test]
    fn grace_deadline_can_escalate_without_a_second_signal() {
        let controller = HttpShutdownController::with_grace_period(
            None,
            Duration::from_millis(2),
        );
        controller.handle_signal(ShutdownTrigger::SigTerm, false);
        thread::sleep(Duration::from_millis(4));
        assert!(controller.deadline_expired());
        assert_eq!(
            controller.force_if_deadline_expired(false),
            ShutdownDecision::Force
        );
        assert_eq!(controller.phase(), ShutdownPhase::Forcing);
    }
}
