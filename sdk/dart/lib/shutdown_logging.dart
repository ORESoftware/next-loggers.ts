import 'dart:async';

import 'next_loggers.dart';
import 'shutdown.dart';

typedef ShutdownObserver = void Function(ShutdownEvent event);
typedef ShutdownFlush = FutureOr<void> Function(ShutdownCause cause);

/// Emits shutdown lifecycle records through next-loggers. The canonical
/// shutdown implementation already exposes the same best-effort logger bridge;
/// this spelling is retained for source compatibility with the IO adapter.
ShutdownObserver loggerShutdownObserver(Logger logger) =>
    loggerShutdownLog(logger);

/// Returns a canonical shutdown flush callback suitable for ProcessShutdownOptions.
ShutdownFlush loggerShutdownFlush(Logger logger) {
  return (_) => logger.flush();
}
