import type {
  BaseLogger,
  LogContextProvider,
  LogFields,
  LogLevel,
  LogRecord,
  LogTransport,
  SerializedValue,
} from './base-logger.js';

/**
 * The OpenTelemetry attribute subset accepted by every current language SDK.
 * Keeping this structural avoids importing an SDK, installing a global provider,
 * or enabling automatic instrumentation in application code.
 */
export type OtelAttributeScalar = string | number | boolean;
export type OtelAttributeValue = OtelAttributeScalar | readonly OtelAttributeScalar[];
export type OtelAttributes = Record<string, OtelAttributeValue>;

export interface OtelSpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string | { serialize?(): string };
}

export interface OtelSpanLike {
  spanContext(): OtelSpanContextLike;
  isRecording?(): boolean;
  addEvent(name: string, attributes?: OtelAttributes, startTime?: Date | number): void;
  recordException?(exception: Error | Record<string, unknown>, time?: Date | number): void;
  setStatus?(status: { code: number; message?: string }): unknown;
  end?(endTime?: Date | number): void;
}

export interface OtelStartSpanOptions {
  kind?: number;
  attributes?: OtelAttributes;
  startTime?: Date | number;
  root?: boolean;
}

export interface OtelTracerLike {
  startActiveSpan<T>(
    name: string,
    options: OtelStartSpanOptions,
    callback: (span: OtelSpanLike) => T,
  ): T;
}

export interface OtelLogRecordLike {
  body?: unknown;
  severityNumber?: number;
  severityText?: string;
  attributes?: OtelAttributes;
  timestamp?: Date | number;
  /** Optional context supplied by the application-owned OpenTelemetry API. */
  context?: unknown;
}

export interface OtelLoggerLike {
  emit(record: OtelLogRecordLike): void;
}

export interface OpenTelemetryTransportOptions {
  /** Logger obtained by the application from its chosen OpenTelemetry SDK. */
  logger: OtelLoggerLike;
  /** Explicit active-span lookup. Never imported from a global OTEL singleton. */
  activeSpan?: () => OtelSpanLike | null | undefined;
  /** Explicit context lookup passed back to the OTEL log emitter, when needed. */
  activeContext?: () => unknown;
  attributes?: OtelAttributes;
  includeFields?: boolean;
  includeValues?: boolean;
  emitSpanEvents?: boolean;
  recordExceptions?: boolean;
  /** Maximum string/JSON attribute length. Default 8192. */
  maxAttributeLength?: number;
  /** Maximum primitive array elements retained in one attribute. Default 64. */
  maxAttributeArrayLength?: number;
  /**
   * Stable attribute names allowed on metrics. High-cardinality trace IDs,
   * request fields, users and messages are excluded by default.
   */
  metricAttributeKeys?: readonly string[];
  /** Optional metrics hook backed by an application-owned OTEL meter. */
  recordMetric?: (name: string, value: number, attributes: OtelAttributes) => void;
  /** Fail open by default; set false only in tests that require exporter errors. */
  failOpen?: boolean;
  onError?: (error: unknown, operation: string, record: LogRecord) => void;
}

export interface WithOpenTelemetrySpanOptions extends OtelStartSpanOptions {
  /** Set false to suppress start/success lifecycle records. Default DEBUG. */
  lifecycleLevel?: Lowercase<LogLevel> | LogLevel | false;
  logFields?: LogFields;
  tags?: readonly string[];
  okStatusCode?: number;
  errorStatusCode?: number;
  /** Throw when the tracer cannot start. Default false: run with a no-op span. */
  failOnStartError?: boolean;
}

const SEVERITY_NUMBER: Record<LogLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const LEVEL_METHOD: Readonly<
  Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>
> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
};

const ERROR_LEVELS = new Set<LogLevel>(['ERROR', 'FATAL']);
const DEFAULT_METRIC_ATTRIBUTES = [
  'service.name',
  'next_logger.runtime',
  'next_logger.level',
  'deployment.environment',
  'service.namespace',
  'service.version',
] as const;

const NOOP_SPAN: OtelSpanLike = Object.freeze({
  spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
  isRecording: () => false,
  addEvent: () => undefined,
  recordException: () => undefined,
  setStatus: () => undefined,
  end: () => undefined,
});

function traceStateText(traceState: OtelSpanContextLike['traceState']): string | undefined {
  if (!traceState) {
    return undefined;
  }
  if (typeof traceState === 'string') {
    return traceState;
  }
  try {
    return traceState.serialize?.();
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximum: number): string {
  if (maximum <= 0 || value.length <= maximum) {
    return value;
  }
  return `${value.slice(0, maximum)}…[truncated ${value.length - maximum} chars]`;
}

function scalar(value: SerializedValue, maximum: number): OtelAttributeScalar | undefined {
  if (typeof value === 'string') {
    return truncate(value, maximum);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function attributeValue(
  value: SerializedValue,
  maximum: number,
  maximumArrayLength: number,
): OtelAttributeValue {
  const direct = scalar(value, maximum);
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(value)) {
    const values = value.slice(0, maximumArrayLength).map((item) => scalar(item, maximum));
    if (values.every((item): item is OtelAttributeScalar => item !== undefined)) {
      return values;
    }
  }
  return truncate(JSON.stringify(value), maximum);
}

function errorFromRecord(record: LogRecord): Error | Record<string, unknown> | undefined {
  const first = record.errors?.[0];
  if (!first) {
    return undefined;
  }
  if (typeof first === 'object' && !Array.isArray(first)) {
    const message = typeof first.message === 'string' ? first.message : record.message;
    const error = new Error(message);
    if (typeof first.name === 'string') {
      error.name = first.name;
    }
    if (typeof first.stack === 'string') {
      error.stack = first.stack;
    }
    return error;
  }
  return { message: String(first) };
}

/** Converts the stable next-loggers record into bounded OTEL attributes. */
export function logRecordToOtelAttributes(
  record: LogRecord,
  options: Pick<
    OpenTelemetryTransportOptions,
    | 'attributes'
    | 'includeFields'
    | 'includeValues'
    | 'maxAttributeLength'
    | 'maxAttributeArrayLength'
  > = {},
): OtelAttributes {
  const maximum = Math.max(0, options.maxAttributeLength ?? 8_192);
  const maximumArrayLength = Math.max(1, Math.floor(options.maxAttributeArrayLength ?? 64));
  // Resource attributes are applied first. Record identity and severity are
  // authoritative and cannot be overridden by configuration.
  const attributes: OtelAttributes = {
    ...options.attributes,
    'log.record.uid': truncate(record.id, maximum),
    'service.name': truncate(record.appName, maximum),
    'next_logger.schema': record.schema,
    'next_logger.runtime': truncate(record.runtime, maximum),
    'next_logger.level': record.level,
    ...(record.name ? { 'logger.name': truncate(record.name, maximum) } : {}),
    ...(record.traceId ? { 'trace.id': truncate(record.traceId, maximum) } : {}),
    ...(record.routineId
      ? { 'next_logger.routine_id': truncate(record.routineId, maximum) }
      : {}),
    ...(record.tags?.length
      ? {
          'next_logger.tags': record.tags
            .slice(0, maximumArrayLength)
            .map((value) => truncate(value, maximum)),
        }
      : {}),
  };

  if (options.includeFields ?? true) {
    for (const [key, value] of Object.entries(record.fields)) {
      attributes[`next_logger.field.${key}`] = attributeValue(
        value,
        maximum,
        maximumArrayLength,
      );
    }
  }
  if (options.includeValues) {
    attributes['next_logger.values'] = truncate(JSON.stringify(record.values), maximum);
  }
  return attributes;
}

function selectMetricAttributes(
  attributes: OtelAttributes,
  allowed: readonly string[] | undefined,
): OtelAttributes {
  const selected: OtelAttributes = {};
  for (const key of allowed ?? DEFAULT_METRIC_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

function isRecording(span: OtelSpanLike): boolean {
  try {
    return span.isRecording?.() !== false;
  } catch {
    return false;
  }
}

/**
 * Reads trace correlation from an application-owned active span and exposes it
 * through next-loggers' existing context provider contract. The caller decides
 * how active spans are stored; this package never mutates runtime facilities.
 */
export function createOpenTelemetryContextProvider(
  activeSpan: () => OtelSpanLike | null | undefined,
): LogContextProvider {
  return () => {
    let span: OtelSpanLike | null | undefined;
    try {
      span = activeSpan();
    } catch {
      return undefined;
    }
    if (!span || !isRecording(span)) {
      return undefined;
    }
    let context: OtelSpanContextLike;
    try {
      context = span.spanContext();
    } catch {
      return undefined;
    }
    if (!context.traceId) {
      return undefined;
    }
    const state = traceStateText(context.traceState);
    return {
      traceId: context.traceId,
      traceIds: [context.traceId],
      fields: {
        'otel.span_id': context.spanId,
        'otel.trace_flags': context.traceFlags,
        ...(state ? { 'otel.trace_state': state } : {}),
      },
      tags: ['otel'],
    };
  };
}

/**
 * Explicit OTEL transport. Logger calls remain the only application-facing API;
 * the transport forwards already-redacted records to application-owned OTEL
 * log/span/metric objects. It performs no global registration or runtime hooks.
 */
export class OpenTelemetryTransport implements LogTransport {
  readonly name = 'opentelemetry';

  constructor(private readonly options: OpenTelemetryTransportOptions) {
    if (!options?.logger || typeof options.logger.emit !== 'function') {
      throw new TypeError('OpenTelemetryTransport requires an injected OTEL logger');
    }
  }

  private report(error: unknown, operation: string, record: LogRecord): void {
    try {
      this.options.onError?.(error, operation, record);
    } catch {
      // Diagnostics must not turn a telemetry error into an application error.
    }
    if (this.options.failOpen === false) {
      throw error;
    }
  }

  private invoke(operation: string, record: LogRecord, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.report(error, operation, record);
    }
  }

  write(record: LogRecord): void {
    let span: OtelSpanLike | undefined;
    if (this.options.activeSpan) {
      try {
        span = this.options.activeSpan() ?? undefined;
      } catch (error) {
        this.report(error, 'read active span', record);
      }
    }
    let spanContext: OtelSpanContextLike | undefined;
    if (span) {
      try {
        spanContext = span.spanContext();
      } catch (error) {
        this.report(error, 'read span context', record);
      }
    }
    const attributes = logRecordToOtelAttributes(record, this.options);

    if (spanContext) {
      attributes['trace.id'] = spanContext.traceId;
      attributes['span.id'] = spanContext.spanId;
      attributes['otel.trace_flags'] = spanContext.traceFlags;
      const state = traceStateText(spanContext.traceState);
      if (state) {
        attributes['otel.trace_state'] = state;
      }
    }

    let activeContext: unknown;
    if (this.options.activeContext) {
      try {
        activeContext = this.options.activeContext();
      } catch (error) {
        this.report(error, 'read active context', record);
      }
    }

    this.invoke('emit log', record, () => {
      this.options.logger.emit({
        body: record.message,
        severityNumber: SEVERITY_NUMBER[record.level],
        severityText: record.level,
        attributes,
        timestamp: new Date(record.timestamp),
        context: activeContext,
      });
    });

    if ((this.options.emitSpanEvents ?? true) && span && isRecording(span)) {
      this.invoke('add span event', record, () => {
        span.addEvent(`log.${record.level.toLowerCase()}`, attributes, new Date(record.timestamp));
      });
      if (ERROR_LEVELS.has(record.level)) {
        const exception = errorFromRecord(record);
        if ((this.options.recordExceptions ?? true) && exception) {
          this.invoke('record exception', record, () => {
            span.recordException?.(exception, new Date(record.timestamp));
          });
        }
        this.invoke('set span status', record, () => {
          span.setStatus?.({ code: 2, message: record.message });
        });
      }
    }

    const metricAttributes = selectMetricAttributes(
      attributes,
      this.options.metricAttributeKeys,
    );
    if (this.options.recordMetric) {
      this.invoke('record log metric', record, () => {
        this.options.recordMetric?.('next_loggers.records', 1, metricAttributes);
      });
      if (ERROR_LEVELS.has(record.level)) {
        this.invoke('record error metric', record, () => {
          this.options.recordMetric?.('next_loggers.errors', 1, metricAttributes);
        });
      }
    }
  }
}

export function createOpenTelemetryTransport(
  options: OpenTelemetryTransportOptions,
): OpenTelemetryTransport {
  return new OpenTelemetryTransport(options);
}

function normalizeLifecycleLevel(
  level: Lowercase<LogLevel> | LogLevel | false | undefined,
): LogLevel | false {
  if (level === false) {
    return false;
  }
  const normalized = String(level ?? 'DEBUG').toUpperCase() as LogLevel;
  return normalized in LEVEL_METHOD ? normalized : 'DEBUG';
}

function spanFields(span: OtelSpanLike, extra: LogFields | undefined): LogFields {
  let context: OtelSpanContextLike | undefined;
  try {
    context = span.spanContext();
  } catch {
    context = undefined;
  }
  return {
    ...(context?.traceId ? { 'otel.trace_id': context.traceId } : {}),
    ...(context?.spanId ? { 'otel.span_id': context.spanId } : {}),
    ...(context ? { 'otel.trace_flags': context.traceFlags } : {}),
    ...extra,
  };
}

async function logSafely(
  logger: BaseLogger,
  level: LogLevel,
  message: string,
  fields: LogFields,
  tags: readonly string[],
  error?: unknown,
): Promise<void> {
  try {
    const method = LEVEL_METHOD[level];
    const event = error === undefined
      ? logger[method](message)
      : logger[method](message, error);
    await event.addFields(fields).addTags('otel-span', ...tags).send();
  } catch {
    // A log sink failure cannot replace the application result.
  }
}

async function invokeSpanSafely(
  logger: BaseLogger,
  operation: string,
  callback: () => void,
  fields: LogFields,
  tags: readonly string[],
): Promise<void> {
  try {
    callback();
  } catch (error) {
    await logSafely(
      logger,
      'WARN',
      `OpenTelemetry ${operation} failed`,
      { ...fields, 'otel.bridge_operation': operation },
      ['otel-bridge-error', ...tags],
      error,
    );
  }
}

/**
 * Explicit span wrapper. Start, success and failure lifecycle records are sent
 * through next-loggers while the application supplies the tracer and context
 * implementation. Span cleanup failures are reported but never replace a
 * successful callback result.
 */
export async function withOpenTelemetrySpan<T>(
  logger: BaseLogger,
  tracer: OtelTracerLike,
  name: string,
  callback: (span: OtelSpanLike) => T | Promise<T>,
  options: WithOpenTelemetrySpanOptions = {},
): Promise<T> {
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('withOpenTelemetrySpan requires a next-loggers logger');
  }
  if (!tracer || typeof tracer.startActiveSpan !== 'function') {
    throw new TypeError('withOpenTelemetrySpan requires an injected OTEL tracer');
  }
  const {
    lifecycleLevel: rawLifecycleLevel,
    logFields,
    tags = [],
    okStatusCode = 1,
    errorStatusCode = 2,
    failOnStartError = false,
    ...spanOptions
  } = options;
  const lifecycleLevel = normalizeLifecycleLevel(rawLifecycleLevel);
  let callbackStarted = false;
  try {
    return await tracer.startActiveSpan(name, spanOptions, async (span) => {
      callbackStarted = true;
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const contextFields = spanFields(span, logFields);
      if (lifecycleLevel !== false) {
        await logSafely(
          logger,
          lifecycleLevel,
          `span started: ${name}`,
          { ...contextFields, 'otel.span_name': name, 'otel.span_phase': 'start' },
          tags,
        );
      }
      try {
        const result = await callback(span);
        await invokeSpanSafely(
          logger,
          'set success status',
          () => span.setStatus?.({ code: okStatusCode }),
          contextFields,
          tags,
        );
        if (lifecycleLevel !== false) {
          await logSafely(
            logger,
            lifecycleLevel,
            `span completed: ${name}`,
            {
              ...contextFields,
              'otel.span_name': name,
              'otel.span_phase': 'end',
              'otel.duration_ms': Math.max(
                0,
                (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
              ),
            },
            tags,
          );
        }
        return result;
      } catch (error) {
        await invokeSpanSafely(
          logger,
          'record exception',
          () => {
            span.recordException?.(
              error instanceof Error ? error : { message: String(error) },
            );
          },
          contextFields,
          tags,
        );
        await invokeSpanSafely(
          logger,
          'set error status',
          () => {
            span.setStatus?.({
              code: errorStatusCode,
              ...(error instanceof Error && error.message ? { message: error.message } : {}),
            });
          },
          contextFields,
          tags,
        );
        await logSafely(
          logger,
          'ERROR',
          `span failed: ${name}`,
          {
            ...contextFields,
            'otel.span_name': name,
            'otel.span_phase': 'error',
            'otel.duration_ms': Math.max(
              0,
              (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
            ),
          },
          tags,
          error,
        );
        throw error;
      } finally {
        await invokeSpanSafely(
          logger,
          'end span',
          () => span.end?.(),
          contextFields,
          tags,
        );
      }
    });
  } catch (error) {
    if (!callbackStarted) {
      await logSafely(
        logger,
        'ERROR',
        `OpenTelemetry start span failed: ${name}`,
        { ...logFields, 'otel.span_name': name, 'otel.span_phase': 'start-error' },
        ['otel-bridge-error', ...tags],
        error,
      );
      if (!failOnStartError) {
        return await callback(NOOP_SPAN);
      }
    }
    throw error;
  }
}
