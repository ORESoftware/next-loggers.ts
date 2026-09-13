import 'dart:async';
import 'dart:io';

import 'shutdown.dart';

final class IoShutdownBinding {
  IoShutdownBinding(this._subscriptions);
  final List<StreamSubscription<dynamic>> _subscriptions;

  Future<void> dispose() async {
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
  }
}

/// Adds native signal and optional stdin-EOF sources to an existing canonical
/// [ProcessShutdownController]. `installProcessShutdown` already installs these
/// sources for the common case; this compatibility adapter is for applications
/// that own controller creation separately.
IoShutdownBinding installIoShutdownSignals(
  ProcessShutdownController controller, {
  bool? interactive,
  bool listenForStdinEof = true,
  Stream<List<int>>? stdinStream,
}) {
  final isInteractive = interactive ?? stdin.hasTerminal;
  final subscriptions = <StreamSubscription<dynamic>>[];

  void request(ShutdownCause cause) {
    if (controller.phase == ShutdownPhase.draining) {
      controller.force(cause);
    } else {
      controller.trigger(cause);
    }
  }

  subscriptions.add(
    ProcessSignal.sigint.watch().listen((_) {
      request(ShutdownCause.sigint);
    }),
  );

  if (!Platform.isWindows) {
    subscriptions.add(
      ProcessSignal.sigterm.watch().listen((_) {
        request(ShutdownCause.sigterm);
      }),
    );
  }

  if (isInteractive && listenForStdinEof) {
    subscriptions.add(
      (stdinStream ?? stdin).listen(
        (_) {},
        onDone: () => request(ShutdownCause.stdinEof),
        cancelOnError: false,
      ),
    );
  }

  return IoShutdownBinding(subscriptions);
}
