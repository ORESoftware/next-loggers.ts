import type {
  LogContextProvider,
  LogLevel,
  LogRecord,
  LogTransport,
  SerializedValue,
} from './base-logger.js';

/**
 * The OpenTelemetry attribute subset accepted by every current language SDK.
 * Keeping this structural avoids importing an SDK, installing a global provider,
 * or enabling automatic instrumentation/monkey patching in application code.
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
  /** Optional metrics hook backed by an application-owned OTEL meter. */
  recordMetric?: (name: string, value: number, attributes: OtelAttributes) => void;
}

const SEVERITY_NUMBER: Record<LogLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const ERROR_LEVELS = new Set<LogLevel>(['ERROR', 'FATAL']);

function traceStateText(traceState: OtelSpanContextLike['traceState']): string | undefined {
  if (!traceState) {
    return undefined;
  }
  if (typeof traceState === 'string') {
    return traceState;
  }
  return traceState.serialize?.();
}

function scalar(value: SerializedValue): OtelAttributeScalar | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function attributeValue(value: SerializedValue): OtelAttributeValue {
  const direct = scalar(value);
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(value)) {
    const values = value.map(scalar);
    if (values.every((item): item is OtelAttributeScalar => item !== undefined)) {
      return values;
    }
  }
  return JSON.stringify(value);
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
  options: Pick<OpenTelemetryTransportOptions, 'attributes' | 'includeFields' | 'includeValues'> = {},
): OtelAttributes {
  const attributes: OtelAttributes = {
    'log.record.uid': record.id,
    'service.name': record.appName,
    'next_logger.schema': record.schema,
    'next_logger.runtime': record.runtime,
    'next_logger.level': record.level,
    ...(record.name ? { 'logger.name': record.name } : {}),
    ...(record.traceId ? { 'trace.id': record.traceId } : {}),
    ...(record.routineId ? { 'next_logger.routine_id': record.routineId } : {}),
    ...(record.tags?.length ? { 'next_logger.tags': record.tags } : {}),
    ...options.attributes,
  };

  if (options.includeFields ?? true) {
    for (const [key, value] of Object.entries(record.fields)) {
      attributes[`next_logger.field.${key}`] = attributeValue(value);
    }
  }
  if (options.includeValues) {
    attributes['next_logger.values'] = JSON.stringify(record.values);
  }
  return attributes;
}

/**
 * Reads trace correlation from an application-owned active span and exposes it
 * through next-loggers' existing context provider contract. The caller decides
 * how active spans are stored (OTEL context, AsyncLocalStorage, thread-local,
 * zone, or an explicit request object); this package never patches a runtime.
 */
export function createOpenTelemetryContextProvider(
  activeSpan: () => OtelSpanLike | null | undefined,
): LogContextProvider {
  return () => {
    const span = activeSpan();
    if (!span || span.isRecording?.() === false) {
      return undefined;
    }
    const context = span.spanContext();
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
 * log/span/metric objects. It performs no global registration, require hooks,
 * prototype mutation, or automatic instrumentation.
 */
export class OpenTelemetryTransport implements LogTransport {
  readonly name = 'opentelemetry';

  constructor(private readonly options: OpenTelemetryTransportOptions) {}

  write(record: LogRecord): void {
    const span = this.options.activeSpan?.() ?? undefined;
    const spanContext = span?.spanContext();
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

    this.options.logger.emit({
      body: record.message,
      severityNumber: SEVERITY_NUMBER[record.level],
      severityText: record.level,
      attributes,
      timestamp: new Date(record.timestamp),
      context: this.options.activeContext?.(),
    });

    if ((this.options.emitSpanEvents ?? true) && span && span.isRecording?.() !== false) {
      span.addEvent(`log.${record.level.toLowerCase()}`, attributes, new Date(record.timestamp));
      if (ERROR_LEVELS.has(record.level)) {
        const exception = errorFromRecord(record);
        if ((this.options.recordExceptions ?? true) && exception) {
          span.recordException?.(exception, new Date(record.timestamp));
        }
        span.setStatus?.({ code: 2, message: record.message });
      }
    }

    this.options.recordMetric?.('next_loggers.records', 1, attributes);
    if (ERROR_LEVELS.has(record.level)) {
      this.options.recordMetric?.('next_loggers.errors', 1, attributes);
    }
  }
}

export function createOpenTelemetryTransport(
  options: OpenTelemetryTransportOptions,
): OpenTelemetryTransport {
  return new OpenTelemetryTransport(options);
}
