import 'dart:async';

import 'next_loggers.dart';
import 'shutdown.dart';

/// Emits shutdown lifecycle records through next-loggers. An injected
/// OpenTelemetry transport receives the same records without this package
/// taking ownership of a global OTEL SDK.
ShutdownObserver loggerShutdownObserver(Logger logger) {
  return (ShutdownEvent event) async {
    final fields = event.toFields();
    if (event.error != null) {
      await logger.error(event.message, fields: fields);
    } else if (event.phase == ShutdownPhase.forcing) {
      await logger.warn(event.message, fields: fields);
    } else {
      await logger.info(event.message, fields: fields);
    }
  };
}

ShutdownAction loggerShutdownFlush(Logger logger) {
  return (_) => logger.flush();
}
