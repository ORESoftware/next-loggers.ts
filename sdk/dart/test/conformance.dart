import 'dart:async';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

final class CaptureTransport
    implements LogTransport, FlushableLogTransport, ClosableLogTransport {
  final List<Map<String, Object?>> records = <Map<String, Object?>>[];
  int flushes = 0;
  bool closed = false;

  @override
  void write(Map<String, Object?> record) => records.add(record);

  @override
  void flush() => flushes += 1;

  @override
  void close() => closed = true;
}

Future<void> main() async {
  final otel = <Map<String, Object?>>[];
  final supabase = <Map<String, Object?>>[];
  final logger = Logger(
    appName: 'payments',
    name: 'audit',
    fields: const {'environment': 'test'},
    idFactory: () => 'dart-record-1',
    clock: () => '2026-01-02T03:04:05.000Z',
    transports: <LogTransport>[
      OpenTelemetryTransport(otel.add),
      SupabaseTransport(supabase.add),
    ],
  );

  late LogContext captured;
  final record = await withLogContext(
    const LogContext(
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      traceState: 'vendor=value',
      routineId: 'charge-card',
      fields: {'requestId': 'request-1'},
      loggedInUser: {'id': 'user-1'},
      tags: ['otel', 'flutter'],
    ),
    () {
      captured = captureLogContext()!;
      return logger.error('payment failed', fields: const {'orderId': 'order-42'});
    },
  );

  assert(record['schema'] == nextLoggersSchema);
  assert(record['level'] == 'ERROR');
  assert(record['traceId'] == '0123456789abcdef0123456789abcdef');
  assert(record['routineId'] == 'charge-card');
  assert((record['loggedInUser'] as Map<String, Object?>)['id'] == 'user-1');
  final fields = record['fields']! as Map<String, Object?>;
  assert(fields['otel.span_id'] == '0123456789abcdef');
  assert(fields['requestId'] == 'request-1');
  assert(fields['orderId'] == 'order-42');
  assert(otel.length == 1);
  assert(otel.single['severityNumber'] == 17);
  assert(supabase.length == 1);
  assert(currentLogContext == null);

  final reentered = await withCapturedLogContext(
    captured,
    () => logger.info('queued'),
  );
  assert(reentered['traceId'] == captured.traceId);
  assert(currentLogContext == null);

  final traces = await Future.wait<String>(<Future<String>>[
    Future<String>(() async {
      return withLogContext(
        const LogContext(traceId: 'trace-a', spanId: 'span-a'),
        () async => (await logger.info('a'))['traceId']! as String,
      );
    }),
    Future<String>(() async {
      return withLogContext(
        const LogContext(traceId: 'trace-b', spanId: 'span-b'),
        () async => (await logger.info('b'))['traceId']! as String,
      );
    }),
  ]);
  assert(traces[0] == 'trace-a');
  assert(traces[1] == 'trace-b');

  final capture = CaptureTransport();
  final lifecycleLogger = Logger(
    appName: 'lifecycle',
    transports: <LogTransport>[capture],
  );
  final draining = Completer<void>();
  var forceCount = 0;
  final coordinator = ShutdownCoordinator(
    gracePeriod: const Duration(seconds: 5),
    drain: (_) => draining.future,
    force: (_) => forceCount += 1,
    flush: loggerShutdownFlush(lifecycleLogger),
    onEvent: loggerShutdownObserver(lifecycleLogger),
  );
  unawaited(coordinator.request(ShutdownTrigger.sigint, interactive: true));
  assert(coordinator.phase == ShutdownPhase.draining);
  final shutdown = await coordinator.request(
    ShutdownTrigger.stdinEof,
    interactive: true,
  );
  assert(shutdown.forced);
  assert(forceCount == 1);
  assert(capture.records.length == 3);
  assert(capture.records.first['message'].toString().contains('graceful'));
  assert(capture.records[1]['message'].toString().contains('forced'));
  assert(capture.records.last['message'] == 'shutdown complete');
  assert(capture.flushes == 1);
  draining.complete();
  await lifecycleLogger.close();
  assert(capture.closed);

  print('Dart/Flutter next-loggers conformance passed');
}
