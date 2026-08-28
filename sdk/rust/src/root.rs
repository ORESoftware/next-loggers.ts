//! Polyglot structured logging, scoped context propagation, and lifecycle tools.

#[path = "lib.rs"]
mod logger_core;

pub use logger_core::*;
pub mod context;
pub mod shutdown;
