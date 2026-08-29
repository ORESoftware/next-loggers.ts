import 'dart:async';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

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

  final record = await withLogContext(
    const LogContext(
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      traceState: 'vendor=value',
      fields: {'requestId': 'request-1'},
      tags: ['otel', 'flutter'],
    ),
    () => logger.error('payment failed', fields: const {'orderId': 'order-42'}),
  );

  assert(record['schema'] == nextLoggersSchema);
  assert(record['level'] == 'ERROR');
  assert(record['traceId'] == '0123456789abcdef0123456789abcdef');
  final fields = record['fields']! as Map<String, Object?>;
  assert(fields['otel.span_id'] == '0123456789abcdef');
  assert(fields['requestId'] == 'request-1');
  assert(fields['orderId'] == 'order-42');
  assert(otel.length == 1);
  assert(otel.single['severityNumber'] == 17);
  assert(supabase.length == 1);
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

  final routedOtel = <Map<String, Object?>>[];
<<<<<<< HEAD
  final routedAll = <Map<String, Object?>>[];
  final routed = Logger(
    appName: 'checkout',
    transports: <LogTransport>[
      OpenTelemetryTransport(routedOtel.add),
      SupabaseTransport(routedAll.add),
    ],
  );
  await routed.info('default on');
  await routed.warn('opted out', otel: false);
  await routed.notOtel().error('logger opted out');
  await routed.notOtel().info('call opted back in', otel: true);
  assert(routedOtel.length == 2);
  assert(routedOtel.first['body'] == 'default on');
  assert(routedOtel.last['body'] == 'call opted back in');
  assert(routedAll.length == 4);
  assert(routed.otel, 'notOtel() must return a derived logger');
=======
  final regular = MemoryTransport();
  final routedLogger = Logger(
    appName: 'routing',
    otel: false,
    transports: <LogTransport>[OpenTelemetryTransport(routedOtel.add), regular],
  );
  final defaultOff = routedLogger.event(LogLevel.info, 'default-off');
  assert(!defaultOff.isOtelEnabled(routedLogger.isOtelEnabled()));
  await defaultOff.send();
  await routedLogger.event(LogLevel.info, 'forced-on').useOtel().send();
  await routedLogger
      .event(LogLevel.info, 'reset-off')
      .useOtel()
      .resetOtel()
      .send();
  routedLogger.useOtel();
  await routedLogger.event(LogLevel.warn, 'forced-off').notOtel().send();
  await routedLogger.event(LogLevel.info, 'logger-on').withOtel(true).send();
  assert(
    routedOtel.map((record) => record['body']).toList().join(',') ==
        'forced-on,logger-on',
  );
  assert(
    regular.records.map((record) => record['message']).toList().join(',') ==
        'default-off,forced-on,reset-off,forced-off,logger-on',
  );
>>>>>>> 0b2ae1c6cf9be0147ff386f3659a554c3853e666

  print('Dart/Flutter next-loggers conformance passed');
}
