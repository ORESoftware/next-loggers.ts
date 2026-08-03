import type {
  BaseLogger,
  LogContext,
  LogContextProvider,
  LogFields,
  LogLevel,
  LogRecord,
  LogTransport,
  LoggerOptions,
} from './base-logger.js';

/**
 * Structural OpenTelemetry interfaces. Applications inject their installed
 * OTel APIs; this package never auto-instruments or monkey-patches a runtime.
 */
export interface OtelSpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
  traceState?: { serialize(): string } | string;
}

export interface OtelSpanLike {
  spanContext(): OtelSpanContextLike;
  setAttribute?(name: string, value: OtelAttributeValue): this | void;
  setAttributes?(attributes: OtelAttributes): this | void;
  addEvent?(name: string, attributes?: OtelAttributes): this | void;
  recordException?(error: unknown): this | void;
  setStatus?(status: { code: number; message?: string }): this | void;
  end?(endTime?: number | Date): void;
}

export interface OtelTracerLike {
  startActiveSpan<T>(
    name: string,
    options: OtelStartSpanOptions,
    callback: (span: OtelSpanLike) => T,
  ): T;
}

export interface OtelTraceApiLike {
  getActiveSpan(): OtelSpanLike | undefined;
  getTracer(name: string, version?: string): OtelTracerLike;
}

export type OtelAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type OtelAttributes = Record<string, OtelAttributeValue>;

export interface OtelLogEmitterLike {
  emit(record: {
    timestamp?: number | Date;
    observedTimestamp?: number | Date;
    context?: unknown;
    severityNumber?: number;
    severityText?: string;
    body?: unknown;
    attributes?: OtelAttributes;
  }): void;
}

export interface OtelLogsApiLike {
  getLogger(name: string, version?: string): OtelLogEmitterLike;
}

export interface OtelStartSpanOptions {
  kind?: number;
  attributes?: OtelAttributes;
  startTime?: number | Date;
  root?: boolean;
}

export interface OtelLogTransportOptions {
  logs: OtelLogsApiLike;
  instrumentationName?: string;
  instrumentationVersion?: string;
  /** Optional active context supplied to the OTel Logs API. */
  activeContext?: () => unknown;
  resourceAttributes?: OtelAttributes;
  /** Maximum JSON string length for non-scalar attributes. Default 8192. */
  maxAttributeLength?: number;
  /** Include redacted next-loggers values as a JSON attribute. Default false. */
  includeValues?: boolean;
}

export interface OtelContextOptions {
  trace: OtelTraceApiLike;
  /** Optional baggage snapshot. Values are added as log fields, never labels. */
  baggage?: () => Readonly<Record<string, string>> | null | undefined;
  includeBaggage?: boolean;
}

export interface WithOtelSpanOptions extends OtelStartSpanOptions {
  /** Logger lifecycle level. Set false to suppress start/success records. */
  lifecycleLevel?: Lowercase<LogLevel> | LogLevel | false;
  /** Fields attached to lifecycle records in addition to span attributes. */
  logFields?: LogFields;
  /** Tags attached to every lifecycle record. */
  tags?: readonly string[];
  /** OTel status code used for success. Default 1 (OK). */
  okStatusCode?: number;
  /** OTel status code used for failures. Default 2 (ERROR). */
  errorStatusCode?: number;
}

export interface OtelBridgeOptions extends OtelContextOptions, OtelLogTransportOptions {
  tracerName?: string;
  tracerVersion?: string;
}

const OTEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
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

function normalizeLifecycleLevel(
  level: Lowercase<LogLevel> | LogLevel | false | undefined,
): LogLevel | false {
  if (level === false) {
    return false;
  }
  const value = String(level ?? 'DEBUG').toUpperCase() as LogLevel;
  return value in LEVEL_METHOD ? value : 'DEBUG';
}

function traceStateText(traceState: OtelSpanContextLike['traceState']): string | undefined {
  if (!traceState) {
    return undefined;
  }
  if (typeof traceState === 'string') {
    return traceState || undefined;
  }
  try {
    return traceState.serialize() || undefined;
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown, maximum: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (maximum <= 0 || text.length <= maximum) {
    return text;
  }
  return `${text.slice(0, maximum)}…[truncated ${text.length - maximum} chars]`;
}

function toOtelAttribute(value: unknown, maximum: number): OtelAttributeValue | undefined {
  if (typeof value === 'string') {
    return value.length <= maximum || maximum <= 0
      ? value
      : `${value.slice(0, maximum)}…[truncated ${value.length - maximum} chars]`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (
    Array.isArray(value) &&
    (value.every((entry) => typeof entry === 'string') ||
      value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ||
      value.every((entry) => typeof entry === 'boolean'))
  ) {
    return value as readonly string[] | readonly number[] | readonly boolean[];
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  return safeJson(value, maximum);
}

function setAttribute(
  target: OtelAttributes,
  name: string,
  value: unknown,
  maximum: number,
): void {
  const converted = toOtelAttribute(value, maximum);
  if (converted !== undefined) {
    target[name] = converted;
  }
}

function recordAttributes(
  record: LogRecord,
  options: Pick<
    OtelLogTransportOptions,
    'includeValues' | 'maxAttributeLength' | 'resourceAttributes'
  >,
): OtelAttributes {
  const maximum = options.maxAttributeLength ?? 8_192;
  const attributes: OtelAttributes = { ...options.resourceAttributes };
  attributes['next_loggers.schema'] = record.schema;
  attributes['next_loggers.record_id'] = record.id;
  attributes['service.name'] = record.appName;
  attributes['next_loggers.runtime'] = record.runtime;
  if (record.name) {
    attributes['logger.name'] = record.name;
  }
  if (record.traceId) {
    attributes['trace.id'] = record.traceId;
  }
  if (record.traceIds?.length) {
    attributes['next_loggers.trace_ids'] = record.traceIds;
  }
  if (record.routineId) {
    attributes['next_loggers.routine_id'] = record.routineId;
  }
  if (record.tags?.length) {
    attributes['next_loggers.tags'] = record.tags;
  }
  for (const [key, value] of Object.entries(record.fields)) {
    setAttribute(attributes, `next_loggers.field.${key}`, value, maximum);
  }
  if (record.loggedInUser) {
    setAttribute(attributes, 'next_loggers.logged_in_user', record.loggedInUser, maximum);
  }
  if (record.users?.length) {
    setAttribute(attributes, 'next_loggers.users', record.users, maximum);
  }
  if (record.context?.length) {
    setAttribute(attributes, 'next_loggers.context', record.context, maximum);
  }
  if (record.meta?.length) {
    setAttribute(attributes, 'next_loggers.meta', record.meta, maximum);
  }
  if (record.errors?.length) {
    setAttribute(attributes, 'exception.events', record.errors, maximum);
  }
  if (record.stackTrace?.length) {
    setAttribute(attributes, 'exception.stacktrace', record.stackTrace.join('\n'), maximum);
  }
  if (options.includeValues) {
    setAttribute(attributes, 'next_loggers.values', record.values, maximum);
  }
  return attributes;
}

export class OtelLogTransport implements LogTransport {
  readonly name = 'otel-logs';
  readonly options: Readonly<OtelLogTransportOptions>;
  private readonly emitter: OtelLogEmitterLike;

  constructor(options: OtelLogTransportOptions) {
    if (!options?.logs || typeof options.logs.getLogger !== 'function') {
      throw new TypeError('OtelLogTransport requires an injected OpenTelemetry logs API');
    }
    this.options = options;
    this.emitter = options.logs.getLogger(
      options.instrumentationName ?? '@oresoftware/next-loggers',
      options.instrumentationVersion,
    );
  }

  write(record: LogRecord): void {
    this.emitter.emit({
      timestamp: new Date(record.timestamp),
      observedTimestamp: Date.now(),
      ...(this.options.activeContext ? { context: this.options.activeContext() } : {}),
      severityNumber: OTEL_SEVERITY[record.level],
      severityText: record.level,
      body: record.message,
      attributes: recordAttributes(record, this.options),
    });
  }
}

export function createOtelLogTransport(options: OtelLogTransportOptions): OtelLogTransport {
  return new OtelLogTransport(options);
}

/**
 * Reads only the currently active span. It does not install hooks, patch async
 * APIs, or start spans. Node/Bun/Deno isolation remains owned by the caller's
 * OTel context manager and next-loggers AsyncLocalStorage.
 */
export function createOtelContextProvider(options: OtelContextOptions): LogContextProvider {
  if (!options?.trace || typeof options.trace.getActiveSpan !== 'function') {
    throw new TypeError('createOtelContextProvider requires an injected OpenTelemetry trace API');
  }
  return (): LogContext | undefined => {
    let span: OtelSpanLike | undefined;
    try {
      span = options.trace.getActiveSpan();
    } catch {
      return undefined;
    }
    if (!span) {
      return undefined;
    }
    let context: OtelSpanContextLike;
    try {
      context = span.spanContext();
    } catch {
      return undefined;
    }
    if (!context?.traceId) {
      return undefined;
    }
    const fields: LogFields = {
      'otel.span_id': context.spanId,
      'otel.trace_flags': context.traceFlags,
      ...(context.isRemote !== undefined ? { 'otel.is_remote': context.isRemote } : {}),
    };
    const state = traceStateText(context.traceState);
    if (state) {
      fields['otel.trace_state'] = state;
    }
    if (options.includeBaggage && options.baggage) {
      try {
        const baggage = options.baggage();
        if (baggage && Object.keys(baggage).length > 0) {
          fields['otel.baggage'] = { ...baggage };
        }
      } catch {
        // A broken baggage accessor must not block application logging.
      }
    }
    return {
      traceId: context.traceId,
      fields,
      tags: ['otel'],
    };
  };
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

function logAt(
  logger: BaseLogger,
  level: LogLevel,
  message: string,
  fields: LogFields,
  tags: readonly string[],
  error?: unknown,
): Promise<void> {
  const method = LEVEL_METHOD[level];
  const event = error === undefined
    ? logger[method](message)
    : logger[method](message, error);
  event.addFields(fields).addTags('otel-span', ...tags);
  return event.send();
}

async function logAtSafely(
  logger: BaseLogger,
  level: LogLevel,
  message: string,
  fields: LogFields,
  tags: readonly string[],
  error?: unknown,
): Promise<void> {
  try {
    await logAt(logger, level, message, fields, tags, error);
  } catch {
    // A telemetry sink failure must never replace the application result.
  }
}

async function callOtelSafely(
  logger: BaseLogger,
  operation: string,
  invoke: () => void,
  fields: LogFields,
  tags: readonly string[],
): Promise<void> {
  try {
    invoke();
  } catch (error) {
    await logAtSafely(
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
 * Explicit span wrapper. OTel calls stay behind this library's logging API:
 * start/success/failure are emitted by next-loggers and the injected span is
 * ended deterministically. Nothing is auto-instrumented.
 */
export async function withOtelSpan<T>(
  logger: BaseLogger,
  tracer: OtelTracerLike,
  name: string,
  callback: (span: OtelSpanLike) => T | Promise<T>,
  options: WithOtelSpanOptions = {},
): Promise<T> {
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('withOtelSpan requires a next-loggers logger');
  }
  if (!tracer || typeof tracer.startActiveSpan !== 'function') {
    throw new TypeError('withOtelSpan requires an injected OpenTelemetry tracer');
  }
  const {
    lifecycleLevel: rawLifecycleLevel,
    logFields,
    tags = [],
    okStatusCode = 1,
    errorStatusCode = 2,
    ...spanOptions
  } = options;
  const lifecycleLevel = normalizeLifecycleLevel(rawLifecycleLevel);
  return tracer.startActiveSpan(name, spanOptions, async (span) => {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    if (lifecycleLevel !== false) {
      await logAtSafely(
        logger,
        lifecycleLevel,
        `span started: ${name}`,
        { ...spanFields(span, logFields), 'otel.span_name': name, 'otel.span_phase': 'start' },
        tags,
      );
    }
    try {
      const result = await callback(span);
      await callOtelSafely(
        logger,
        'set success status',
        () => span.setStatus?.({ code: okStatusCode }),
        spanFields(span, logFields),
        tags,
      );
      if (lifecycleLevel !== false) {
        const finishedAt = globalThis.performance?.now?.() ?? Date.now();
        await logAtSafely(
          logger,
          lifecycleLevel,
          `span completed: ${name}`,
          {
            ...spanFields(span, logFields),
            'otel.span_name': name,
            'otel.span_phase': 'end',
            'otel.duration_ms': Math.max(0, finishedAt - startedAt),
          },
          tags,
        );
      }
      return result;
    } catch (error) {
      await callOtelSafely(
        logger,
        'record exception',
        () => span.recordException?.(error),
        spanFields(span, logFields),
        tags,
      );
      await callOtelSafely(
        logger,
        'set error status',
        () => span.setStatus?.({
          code: errorStatusCode,
          ...(error instanceof Error && error.message ? { message: error.message } : {}),
        }),
        spanFields(span, logFields),
        tags,
      );
      await logAtSafely(
        logger,
        'ERROR',
        `span failed: ${name}`,
        {
          ...spanFields(span, logFields),
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
      await callOtelSafely(
        logger,
        'end span',
        () => span.end?.(),
        spanFields(span, logFields),
        tags,
      );
    }
  });
}

export interface OtelBridge {
  readonly contextProvider: LogContextProvider;
  readonly logTransport: OtelLogTransport;
  readonly tracer: OtelTracerLike;
  withSpan<T>(
    logger: BaseLogger,
    name: string,
    callback: (span: OtelSpanLike) => T | Promise<T>,
    options?: WithOtelSpanOptions,
  ): Promise<T>;
  /** Safely composes OTel transport/context into existing logger options. */
  loggerOptions<T extends LoggerOptions>(options?: T): T & LoggerOptions;
}

export function createOtelBridge(options: OtelBridgeOptions): OtelBridge {
  const contextProvider = createOtelContextProvider(options);
  const logTransport = createOtelLogTransport(options);
  const tracer = options.trace.getTracer(
    options.tracerName ?? options.instrumentationName ?? '@oresoftware/next-loggers',
    options.tracerVersion ?? options.instrumentationVersion,
  );
  return {
    contextProvider,
    logTransport,
    tracer,
    withSpan: (logger, name, callback, spanOptions) =>
      withOtelSpan(logger, tracer, name, callback, spanOptions),
    loggerOptions<T extends LoggerOptions>(loggerOptions: T = {} as T): T & LoggerOptions {
      const existing = loggerOptions.transports
        ? Array.isArray(loggerOptions.transports)
          ? loggerOptions.transports
          : [loggerOptions.transports]
        : [];
      return {
        ...loggerOptions,
        contextProvider,
        transports: [...existing, logTransport],
      };
    },
  };
}
