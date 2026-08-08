import 'dart:async';
import 'dart:convert';
import 'dart:math';

const String nextLoggersSchema = 'next-loggers/v1';
final Object _contextZoneKey = Object();

enum LogLevel { trace, debug, info, warn, error, fatal }

extension LogLevelWire on LogLevel {
  String get wire => name.toUpperCase();

  int get otelSeverityNumber => switch (this) {
        LogLevel.trace => 1,
        LogLevel.debug => 5,
        LogLevel.info => 9,
        LogLevel.warn => 13,
        LogLevel.error => 17,
        LogLevel.fatal => 21,
      };
}

final class LogContext {
  const LogContext({
    this.traceId,
    this.traceIds = const <String>[],
    this.spanId,
    this.traceFlags = 0,
    this.traceState,
    this.routineId,
    this.fields = const <String, Object?>{},
    this.loggedInUser = const <String, Object?>{},
    this.users = const <Map<String, Object?>>[],
    this.tags = const <String>[],
    this.context = const <Object?>[],
    this.meta = const <Object?>[],
  });

  final String? traceId;
  final List<String> traceIds;
  final String? spanId;
  final int traceFlags;
  final String? traceState;
  final String? routineId;
  final Map<String, Object?> fields;
  final Map<String, Object?> loggedInUser;
  final List<Map<String, Object?>> users;
  final List<String> tags;
  final List<Object?> context;
  final List<Object?> meta;

  LogContext snapshot() => LogContext(
        traceId: traceId,
        traceIds: List<String>.unmodifiable(traceIds),
        spanId: spanId,
        traceFlags: traceFlags,
        traceState: traceState,
        routineId: routineId,
        fields: Map<String, Object?>.unmodifiable(fields),
        loggedInUser: Map<String, Object?>.unmodifiable(loggedInUser),
        users: List<Map<String, Object?>>.unmodifiable(
          users.map((user) => Map<String, Object?>.unmodifiable(user)),
        ),
        tags: List<String>.unmodifiable(tags),
        context: List<Object?>.unmodifiable(context),
        meta: List<Object?>.unmodifiable(meta),
      );

  LogContext merge(LogContext patch) {
    final mergedTraceIds = <String>{...traceIds};
    if (traceId != null && traceId!.isNotEmpty) mergedTraceIds.add(traceId!);
    mergedTraceIds.addAll(patch.traceIds.where((value) => value.isNotEmpty));
    if (patch.traceId != null && patch.traceId!.isNotEmpty) {
      mergedTraceIds.add(patch.traceId!);
    }
    return LogContext(
      traceId: patch.traceId ?? traceId,
      traceIds: mergedTraceIds.toList(growable: false),
      spanId: patch.spanId ?? spanId,
      traceFlags: patch.traceFlags == 0 ? traceFlags : patch.traceFlags,
      traceState: patch.traceState ?? traceState,
      routineId: patch.routineId ?? routineId,
      fields: <String, Object?>{...fields, ...patch.fields},
      loggedInUser: <String, Object?>{...loggedInUser, ...patch.loggedInUser},
      users: <Map<String, Object?>>[
        ...users.map((user) => Map<String, Object?>.from(user)),
        ...patch.users.map((user) => Map<String, Object?>.from(user)),
      ],
      tags: <String>{...tags, ...patch.tags}.toList(growable: false),
      context: <Object?>[...context, ...patch.context],
      meta: <Object?>[...meta, ...patch.meta],
    ).snapshot();
  }
}

LogContext? get currentLogContext => Zone.current[_contextZoneKey] as LogContext?;

/// Enters an exact nested Zone frame and restores the previous frame when the
/// callback or returned Future settles.
R withLogContext<R>(LogContext context, R Function() callback) {
  return runZoned(
    callback,
    zoneValues: <Object, Object?>{_contextZoneKey: context.snapshot()},
  );
}

/// Enters a frame merged over the current Zone context.
R withMergedLogContext<R>(LogContext patch, R Function() callback) {
  final current = currentLogContext;
  final next = current == null ? patch.snapshot() : current.merge(patch);
  return withLogContext(next, callback);
}

/// Captures a defensive snapshot for a queue, isolate handoff, or callback.
LogContext? captureLogContext() => currentLogContext?.snapshot();

R withCapturedLogContext<R>(LogContext? captured, R Function() callback) {
  return captured == null ? callback() : withLogContext(captured, callback);
}

R Function() bindLogContext<R>(R Function() callback) {
  final captured = captureLogContext();
  return () => withCapturedLogContext(captured, callback);
}

typedef RecordSender = FutureOr<void> Function(Map<String, Object?> record);

abstract interface class LogTransport {
  FutureOr<void> write(Map<String, Object?> record);
}

abstract interface class FlushableLogTransport {
  FutureOr<void> flush();
}

abstract interface class ClosableLogTransport {
  FutureOr<void> close();
}

/// Application-owned OTEL sink. This package never registers a global SDK.
final class OpenTelemetryTransport implements LogTransport {
  OpenTelemetryTransport(this.emit);

  final RecordSender emit;

  @override
  FutureOr<void> write(Map<String, Object?> record) {
    final level = LogLevel.values.firstWhere(
      (value) => value.wire == record['level'],
    );
    final fields = (record['fields'] as Map<String, Object?>?) ?? const {};
    final user = record['loggedInUser'] as Map<String, Object?>?;
    final attributes = <String, Object?>{
      'service.name': record['appName'],
      'next_logger.schema': record['schema'],
      'next_logger.runtime': record['runtime'],
      'log.record.uid': record['id'],
      if (record['traceId'] != null) 'trace.id': record['traceId'],
      if (user != null && user['id'] != null) 'enduser.id': user['id'],
      for (final entry in fields.entries) 'next_logger.field.${entry.key}': entry.value,
    };
    return emit(<String, Object?>{
      'body': record['message'],
      'severityText': level.wire,
      'severityNumber': level.otelSeverityNumber,
      'timestamp': record['timestamp'],
      'attributes': attributes,
    });
  }
}

/// Flutter/browser-safe Supabase transport with an injected authenticated sender.
final class SupabaseTransport implements LogTransport {
  SupabaseTransport(this.send);

  final RecordSender send;

  @override
  FutureOr<void> write(Map<String, Object?> record) => send(record);
}

final class Logger {
  Logger({
    required this.appName,
    this.name,
    this.runtime = 'dart',
    Map<String, Object?> fields = const <String, Object?>{},
    Map<String, Object?> loggedInUser = const <String, Object?>{},
    List<LogTransport> transports = const <LogTransport>[],
    String Function()? idFactory,
    String Function()? clock,
  })  : fields = Map<String, Object?>.unmodifiable(fields),
        loggedInUser = Map<String, Object?>.unmodifiable(loggedInUser),
        transports = List<LogTransport>.unmodifiable(transports),
        _idFactory = idFactory ?? _randomId,
        _clock = clock ?? (() => DateTime.now().toUtc().toIso8601String());

  final String appName;
  final String? name;
  final String runtime;
  final Map<String, Object?> fields;
  final Map<String, Object?> loggedInUser;
  final List<LogTransport> transports;
  final String Function() _idFactory;
  final String Function() _clock;

  Future<Map<String, Object?>> log(
    LogLevel level,
    String message, {
    Map<String, Object?> eventFields = const <String, Object?>{},
    Map<String, Object?> eventLoggedInUser = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) async {
    if (appName.trim().isEmpty) {
      throw ArgumentError.value(appName, 'appName', 'must not be empty');
    }
    final logContext = currentLogContext;
    final mergedFields = <String, Object?>{
      ...fields,
      ...?logContext?.fields,
      if (logContext?.spanId != null) 'otel.span_id': logContext!.spanId,
      if (logContext != null) 'otel.trace_flags': logContext.traceFlags,
      if (logContext?.traceState != null) 'otel.trace_state': logContext!.traceState,
      ...eventFields,
    };
    final mergedUser = <String, Object?>{
      ...loggedInUser,
      ...?logContext?.loggedInUser,
      ...eventLoggedInUser,
    };
    final traceId = logContext?.traceId;
    final traceIds = <String>{};
    if (logContext != null) traceIds.addAll(logContext.traceIds);
    if (traceId != null && traceId.isNotEmpty) traceIds.add(traceId);
    final routineId = logContext?.routineId;
    final record = <String, Object?>{
      'schema': nextLoggersSchema,
      'id': _idFactory(),
      'timestamp': _clock(),
      'level': level.wire,
      'runtime': runtime,
      'appName': appName,
      if (name != null && name!.isNotEmpty) 'name': name,
      'message': message,
      'values': values.isEmpty ? <Object?>[message] : List<Object?>.from(values),
      'fields': mergedFields,
      if (mergedUser.isNotEmpty) 'loggedInUser': mergedUser,
      if (logContext != null && logContext.users.isNotEmpty)
        'users': logContext.users
            .map((user) => Map<String, Object?>.from(user))
            .toList(growable: false),
      if (traceId != null && traceId.isNotEmpty) 'traceId': traceId,
      if (traceIds.isNotEmpty) 'traceIds': traceIds.toList(growable: false),
      if (routineId != null && routineId.isNotEmpty) 'routineId': routineId,
      if (logContext != null && logContext.tags.isNotEmpty)
        'tags': List<String>.from(logContext.tags),
      if (logContext != null && logContext.context.isNotEmpty)
        'context': List<Object?>.from(logContext.context),
      if (logContext != null && logContext.meta.isNotEmpty)
        'meta': List<Object?>.from(logContext.meta),
    };
    final immutable = _deepCopy(record);
    for (final transport in transports) {
      await transport.write(immutable);
    }
    return immutable;
  }

  Future<Map<String, Object?>> trace(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.trace, message, eventFields: fields);

  Future<Map<String, Object?>> debug(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.debug, message, eventFields: fields);

  Future<Map<String, Object?>> info(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.info, message, eventFields: fields);

  Future<Map<String, Object?>> warn(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.warn, message, eventFields: fields);

  Future<Map<String, Object?>> error(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.error, message, eventFields: fields);

  Future<Map<String, Object?>> fatal(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.fatal, message, eventFields: fields);

  Future<void> flush() async {
    for (final transport in transports) {
      if (transport is FlushableLogTransport) await transport.flush();
    }
  }

  Future<void> close() async {
    await flush();
    for (final transport in transports) {
      if (transport is ClosableLogTransport) await transport.close();
    }
  }

  static String _randomId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }
}

Map<String, Object?> _deepCopy(Map<String, Object?> value) {
  return jsonDecode(jsonEncode(value)) as Map<String, Object?>;
}
