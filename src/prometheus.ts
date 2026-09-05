import type { LogRecord, LogTransport } from './base-logger.js';

export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

export interface MetricOptions {
  help: string;
  labelNames?: readonly string[];
  /** Maximum total series, including the reserved overflow series. Default 1000. */
  maxSeries?: number;
  /** Maximum UTF-16 code units retained per label value. Default 256. */
  maxLabelValueLength?: number;
  /** Internal compatibility mode retaining a visible overflow series. */
  reserveOverflow?: boolean;
}

export interface PrometheusRegistryOptions {
  /** Metric namespace. Defaults to next_loggers. */
  prefix?: string;
  /** Maximum series per metric. Defaults to 1000. */
  maxSeriesPerMetric?: number;
  /** Maximum label value length. Defaults to 256. */
  maxLabelValueLength?: number;
}

export interface ResponseOptions {
  status?: number;
  headers?: HeadersInit;
}

interface NormalizedLabels {
  key: string;
  rendered: string;
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const DEFAULT_MAX_SERIES = 1_000;
const DEFAULT_MAX_LABEL_VALUE_LENGTH = 256;
const OVERFLOW_LABEL_VALUE = '__overflow__';

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) {
    throw new TypeError(`Invalid Prometheus metric name/identifier: ${name}`);
  }
}

function assertLabelName(name: string): void {
  if (!LABEL_NAME.test(name) || name.startsWith('__') || name === 'le') {
    throw new TypeError(`Invalid or reserved Prometheus label name: ${name}`);
  }
}

function escapeHelp(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/"/gu, '\\"');
}

function boundedLabelValue(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Metric value must be finite value, got ${value}`);
  }
  return value;
}

function normalizeLabels(
  labelNames: readonly string[],
  labels: MetricLabels = {},
  maxLabelValueLength = DEFAULT_MAX_LABEL_VALUE_LENGTH,
): NormalizedLabels {
  if (labelNames.length > 0 && labels === undefined) {
    throw new TypeError(`missing Prometheus labels: ${labelNames.join(', ')}`);
  }
  const supplied = labels ?? {};
  const unknown = Object.keys(labels).filter((name) => !labelNames.includes(name));
  if (unknown.length > 0) {
    throw new TypeError(`unexpected Prometheus labels: ${unknown.join(', ')}`);
  }
  const missing = labelNames.filter((name) => !Object.prototype.hasOwnProperty.call(supplied, name));
  if (missing.length > 0) {
    throw new TypeError(`missing Prometheus labels: ${missing.join(', ')}`);
  }
  const values = labelNames.map((name) =>
    boundedLabelValue(String(supplied[name] ?? ''), maxLabelValueLength),
  );
  const key = JSON.stringify(values);
  const rendered = labelNames.length === 0
    ? ''
    : `{${labelNames.map((name, index) => `${name}="${escapeLabel(values[index] ?? '')}"`).join(',')}}`;
  return { key, rendered };
}

abstract class MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly maxSeries: number;
  readonly maxLabelValueLength: number;
  readonly reserveOverflow: boolean;
  protected readonly labelText = new Map<string, string>();
  private dropped = 0;
  private readonly onDrop: (() => void) | undefined;

  constructor(name: string, options: MetricOptions, onDrop?: () => void) {
    assertMetricName(name);
    for (const label of options.labelNames ?? []) {
      assertLabelName(label);
    }
    if (!options.help?.trim()) {
      throw new TypeError(`Prometheus metric ${name} requires non-empty help text`);
    }
    const labels = [...(options.labelNames ?? [])];
    if (new Set(labels).size !== labels.length) {
      throw new TypeError(`Prometheus metric ${name} contains duplicate label names`);
    }
    this.name = name;
    this.help = options.help;
    this.labelNames = Object.freeze(labels);
    this.maxSeries = positiveInteger(options.maxSeries, DEFAULT_MAX_SERIES);
    this.maxLabelValueLength = positiveInteger(
      options.maxLabelValueLength,
      DEFAULT_MAX_LABEL_VALUE_LENGTH,
    );
    this.onDrop = onDrop;
    this.reserveOverflow = options.reserveOverflow ?? true;
  }

  protected normalize(labels?: MetricLabels): NormalizedLabels {
    return normalizeLabels(this.labelNames, labels, this.maxLabelValueLength);
  }

  private overflow(): NormalizedLabels {
    const overflow: Record<string, MetricLabelValue> = {};
    for (const name of this.labelNames) {
      overflow[name] = OVERFLOW_LABEL_VALUE;
    }
    return normalizeLabels(
      this.labelNames,
      overflow,
      Math.max(this.maxLabelValueLength, OVERFLOW_LABEL_VALUE.length),
    );
  }

  protected labels(labels?: MetricLabels): NormalizedLabels {
    const normalized = this.normalize(labels);
    if (this.labelText.has(normalized.key)) {
      return normalized;
    }

    if (this.labelNames.length === 0) {
      this.labelText.set(normalized.key, normalized.rendered);
      return normalized;
    }

    // One slot is permanently reserved for bounded overflow. This makes
    // maxSeries an actual upper bound rather than maxSeries + 1.
    const ordinaryBudget = this.reserveOverflow
      ? Math.max(0, this.maxSeries - 1)
      : this.maxSeries;
    const overflow = this.overflow();
    const ordinaryCount = this.labelText.has(overflow.key)
      ? this.labelText.size - 1
      : this.labelText.size;
    if (ordinaryCount >= ordinaryBudget) {
      this.dropped += 1;
      this.onDrop?.();
      if (this.reserveOverflow) {
        this.labelText.set(overflow.key, overflow.rendered);
      }
      return overflow;
    }

    this.labelText.set(normalized.key, normalized.rendered);
    return normalized;
  }

  protected keyForGet(labels?: MetricLabels): string {
    const normalized = this.normalize(labels);
    if (this.labelText.has(normalized.key) || this.labelNames.length === 0) {
      return normalized.key;
    }
    const overflow = this.overflow();
    return this.labelText.has(overflow.key) ? overflow.key : normalized.key;
  }

  expositionNames(): readonly string[] {
    return [this.name];
  }

  abstract render(): string[];

  protected isHiddenOverflow(key: string): boolean {
    return !this.reserveOverflow && this.labelNames.length > 0 && key === this.overflow().key;
  }

  droppedSeries(): number {
    return this.dropped;
  }
}

export class Counter extends MetricBase {
  private readonly values = new Map<string, number>();

  constructor(name: string, options: MetricOptions, onDrop?: () => void) {
    super(name, options, onDrop);
  }

  add(value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Prometheus counters require a non-negative increment');
    }
    const normalized = this.labels(labels);
    this.values.set(normalized.key, (this.values.get(normalized.key) ?? 0) + value);
  }

  inc(labels?: MetricLabels, value = 1): void {
    if (typeof labels === 'number') {
      this.add(labels, (value as unknown as MetricLabels) ?? undefined);
      return;
    }
    this.add(value, labels);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(this.keyForGet(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      if (this.isHiddenOverflow(key)) continue;
      lines.push(`${this.name}${this.labelText.get(key) ?? ''} ${value}`);
    }
    return lines;
  }
}

export class Gauge extends MetricBase {
  private readonly values = new Map<string, number>();

  constructor(name: string, options: MetricOptions, onDrop?: () => void) {
    super(name, options, onDrop);
  }

  set(value: number, labels?: MetricLabels): void;
  set(labels: MetricLabels | undefined, value: number): void;
  set(first: number | MetricLabels | undefined, second?: MetricLabels | number): void {
    const value = typeof first === 'number' ? first : second as number;
    const labels = typeof first === 'number' ? second as MetricLabels | undefined : first;
    const normalized = this.labels(labels);
    this.values.set(normalized.key, finite(value));
  }

  add(value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Metric delta must be finite delta, got ${value}`);
    }
    const normalized = this.labels(labels);
    this.values.set(normalized.key, (this.values.get(normalized.key) ?? 0) + value);
  }

  inc(labels?: MetricLabels, value = 1): void {
    if (typeof labels === 'number') {
      this.add(labels, value as unknown as MetricLabels);
      return;
    }
    this.add(value, labels);
  }

  dec(labels?: MetricLabels, value = 1): void {
    if (typeof labels === 'number') {
      this.add(-labels, value as unknown as MetricLabels);
      return;
    }
    this.add(-value, labels);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(this.keyForGet(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      if (this.isHiddenOverflow(key)) continue;
      lines.push(`${this.name}${this.labelText.get(key) ?? ''} ${value}`);
    }
    return lines;
  }
}

interface HistogramState {
  buckets: number[];
  count: number;
  sum: number;
}

export interface HistogramOptions extends MetricOptions {
  buckets?: readonly number[];
}

export class Histogram extends MetricBase {
  readonly buckets: readonly number[];
  private readonly values = new Map<string, HistogramState>();

  constructor(name: string, options: HistogramOptions, onDrop?: () => void) {
    super(name, options, onDrop);
    const buckets = [...(
      options.buckets ?? [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    )]
      .map((value) => {
        if (!Number.isFinite(value)) return Number.NaN;
        return value;
      });
    if (buckets.length === 0 || buckets.some((value, index) =>
      !Number.isFinite(value) || (index > 0 && value <= (buckets[index - 1] ?? value)))) {
      throw new TypeError(`Histogram ${name} buckets must be strictly increasing`);
    }
    this.buckets = Object.freeze(buckets);
  }

  expositionNames(): readonly string[] {
    return [this.name, `${this.name}_bucket`, `${this.name}_sum`, `${this.name}_count`];
  }

  observe(value: number, labels?: MetricLabels): void;
  observe(labels: MetricLabels | undefined, value: number): void;
  observe(first: number | MetricLabels | undefined, second?: MetricLabels | number): void {
    const value = typeof first === 'number' ? first : second as number;
    const labels = typeof first === 'number' ? second as MetricLabels | undefined : first;
    if (!Number.isFinite(value)) {
      throw new TypeError(`Histogram observation must be finite observation, got ${value}`);
    }
    const observed = value;
    const normalized = this.labels(labels);
    const state = this.values.get(normalized.key) ?? {
      buckets: this.buckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (observed <= (this.buckets[index] ?? Number.POSITIVE_INFINITY)) {
        state.buckets[index] = (state.buckets[index] ?? 0) + 1;
      }
    }
    state.count += 1;
    state.sum += observed;
    this.values.set(normalized.key, state);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const [key, state] of this.values) {
      if (this.isHiddenOverflow(key)) continue;
      const rendered = this.labelText.get(key) ?? '';
      const baseLabels = rendered ? rendered.slice(1, -1) : '';
      for (let index = 0; index < this.buckets.length; index += 1) {
        const separator = baseLabels ? ',' : '';
        lines.push(
          `${this.name}_bucket{${baseLabels}${separator}le="${this.buckets[index]}"} ${state.buckets[index] ?? 0}`,
        );
      }
      const separator = baseLabels ? ',' : '';
      lines.push(`${this.name}_bucket{${baseLabels}${separator}le="+Inf"} ${state.count}`);
      lines.push(`${this.name}_sum${rendered} ${state.sum}`);
      lines.push(`${this.name}_count${rendered} ${state.count}`);
    }
    return lines;
  }
}

export class PrometheusRegistry {
  private readonly metrics = new Map<string, MetricBase>();
  private readonly expositionNames = new Set<string>();
  private readonly prefix: string;
  private readonly prefixConfigured: boolean;
  private readonly maxSeriesPerMetric: number;
  private readonly maxLabelValueLength: number;
  private droppedSeries = 0;

  constructor(options: PrometheusRegistryOptions = {}) {
    const prefix = options.prefix ?? 'next_loggers';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(prefix)) {
      throw new TypeError(`Invalid Prometheus metric prefix: ${prefix}`);
    }
    this.prefix = prefix;
    this.prefixConfigured = options.prefix !== undefined;
    this.maxSeriesPerMetric = Math.max(1, Math.floor(
      Number.isFinite(options.maxSeriesPerMetric) ? Number(options.maxSeriesPerMetric) : DEFAULT_MAX_SERIES,
    ));
    this.maxLabelValueLength = positiveInteger(
      options.maxLabelValueLength,
      DEFAULT_MAX_LABEL_VALUE_LENGTH,
    );
  }

  private metricName(name: string): string {
    return name === this.prefix || name.startsWith(`${this.prefix}_`)
      ? name
      : `${this.prefix}_${name}`;
  }

  private normalizeOptions<T extends MetricOptions>(
    nameOrOptions: string | (T & { name: string }),
    options?: T,
  ): { name: string; options: T } {
    if (typeof nameOrOptions === 'string') {
      assertMetricName(nameOrOptions);
      return {
        name: this.prefixConfigured ? this.metricName(nameOrOptions) : nameOrOptions,
        options: {
          ...(options as T),
          maxSeries: options?.maxSeries ?? this.maxSeriesPerMetric,
          maxLabelValueLength: options?.maxLabelValueLength ?? this.maxLabelValueLength,
          reserveOverflow: options?.reserveOverflow ?? true,
        },
      };
    }
    assertMetricName(nameOrOptions.name);
    return {
      name: this.metricName(nameOrOptions.name),
      options: {
        ...nameOrOptions,
        maxSeries: nameOrOptions.maxSeries ?? this.maxSeriesPerMetric,
        maxLabelValueLength: nameOrOptions.maxLabelValueLength ?? this.maxLabelValueLength,
        reserveOverflow: nameOrOptions.reserveOverflow ?? false,
      },
    };
  }

  counter(name: string, options: MetricOptions): Counter;
  counter(options: MetricOptions & { name: string }): Counter;
  counter(nameOrOptions: string | (MetricOptions & { name: string }), options?: MetricOptions): Counter {
    const normalized = this.normalizeOptions(nameOrOptions, options);
    return this.register(new Counter(normalized.name, normalized.options, () => { this.droppedSeries += 1; }));
  }

  gauge(name: string, options: MetricOptions): Gauge;
  gauge(options: MetricOptions & { name: string }): Gauge;
  gauge(nameOrOptions: string | (MetricOptions & { name: string }), options?: MetricOptions): Gauge {
    const normalized = this.normalizeOptions(nameOrOptions, options);
    return this.register(new Gauge(normalized.name, normalized.options, () => { this.droppedSeries += 1; }));
  }

  histogram(name: string, options: HistogramOptions): Histogram;
  histogram(options: HistogramOptions & { name: string }): Histogram;
  histogram(nameOrOptions: string | (HistogramOptions & { name: string }), options?: HistogramOptions): Histogram {
    const normalized = this.normalizeOptions(nameOrOptions, options);
    return this.register(new Histogram(normalized.name, normalized.options, () => { this.droppedSeries += 1; }));
  }

  register<T extends MetricBase>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Prometheus metric is already registered: ${metric.name}`);
    }
    const collisions = metric.expositionNames().filter((name) => this.expositionNames.has(name));
    if (collisions.length > 0) {
      throw new Error(`Prometheus exposition name is already registered: ${collisions.join(', ')}`);
    }
    this.metrics.set(metric.name, metric);
    for (const name of metric.expositionNames()) {
      this.expositionNames.add(name);
    }
    return metric;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of [...this.metrics.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(...metric.render());
    }
    if (this.droppedSeries > 0) {
      const name = `${this.prefix}_dropped_series_total`;
      lines.push(`# HELP ${name} Number of metric label series dropped by cardinality bounds.`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${this.droppedSeries}`);
    }
    return `${lines.join('\n')}\n`;
  }

  response(options: ResponseOptions = {}): Response {
    const headers = new Headers(options.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    }
    headers.set('cache-control', 'no-store');
    return new Response(this.render(), {
      status: options.status ?? 200,
      headers,
    });
  }
}

export interface LoggerMetrics {
  records: Counter;
  transportWrites: Counter;
  transportDurationSeconds: Histogram;
  transportInFlight: Gauge;
  transportDropped: Counter;
  pendingLogs: Gauge;
}

export function createLoggerMetrics(registry = new PrometheusRegistry()): {
  registry: PrometheusRegistry;
  metrics: LoggerMetrics;
} {
  return {
    registry,
    metrics: {
      records: registry.counter('next_loggers_records_total', {
        help: 'Number of next-loggers records observed at the logger boundary.',
        labelNames: ['level', 'runtime'],
      }),
      transportWrites: registry.counter('next_loggers_transport_writes_total', {
        help: 'Number of logger transport writes by outcome.',
        labelNames: ['transport', 'outcome'],
      }),
      transportDurationSeconds: registry.histogram('next_loggers_transport_write_duration_seconds', {
        help: 'Duration of logger transport writes.',
        labelNames: ['transport'],
      }),
      transportInFlight: registry.gauge('next_loggers_transport_in_flight', {
        help: 'Current logger writes in flight.',
        labelNames: ['transport'],
      }),
      transportDropped: registry.counter('next_loggers_transport_dropped_total', {
        help: 'Records dropped by a bounded logger transport.',
        labelNames: ['transport', 'reason'],
      }),
      pendingLogs: registry.gauge('next_loggers_pending_writes', {
        help: 'Current process-wide pending logger writes.',
      }),
    },
  };
}

export function isErrorLevel(level: unknown): level is 'ERROR' | 'FATAL' {
  return level === 'ERROR' || level === 'FATAL';
}

export interface LoggerPrometheusMetricsOptions {
  registry?: PrometheusRegistry;
  environment?: string;
  recordSizeBuckets?: readonly number[];
}

export interface LoggerPrometheusMetrics {
  registry: PrometheusRegistry;
  transport: LogTransport;
  metrics: {
    records: Counter;
    errorRecords: Counter;
    traceCorrelatedRecords: Counter;
    recordBytes: Histogram;
  };
}

/**
 * Creates a bounded, low-cardinality Prometheus transport for logger records.
 * Only service identity, runtime, level, and an optional deployment environment
 * are labels; trace IDs, messages, fields, and customer data remain payload-free.
 */
export function createLoggerPrometheusMetrics(
  options: LoggerPrometheusMetricsOptions | PrometheusRegistry = {},
): LoggerPrometheusMetrics {
  const config = options instanceof PrometheusRegistry ? { registry: options } : options;
  const registry = config.registry ?? new PrometheusRegistry();
  const environment = config.environment ?? 'unknown';
  const labelNames = ['app_name', 'runtime', 'level', 'environment'] as const;
  const records = registry.counter({
    name: 'records_total',
    help: 'Number of logger records observed.',
    labelNames,
  });
  const errorRecords = registry.counter({
    name: 'error_records_total',
    help: 'Number of ERROR and FATAL logger records observed.',
    labelNames,
  });
  const traceCorrelatedRecords = registry.counter({
    name: 'trace_correlated_records_total',
    help: 'Number of records with an explicit primary trace identifier.',
    labelNames,
  });
  const recordBytes = registry.histogram({
    name: 'record_bytes',
    help: 'Serialized logger record size in bytes.',
    buckets: config.recordSizeBuckets ?? [64, 256, 1_024, 4_096, 16_384, 65_536, 262_144],
  });
  const labelsFor = (record: LogRecord): MetricLabels => ({
    app_name: record.appName || 'unknown',
    runtime: String(record.runtime),
    level: record.level,
    environment,
  });
  const transport: LogTransport = {
    name: 'prometheus',
    write(record) {
      const labels = labelsFor(record);
      records.inc(labels);
      if (isErrorLevel(record.level)) {
        errorRecords.inc(labels);
      }
      if (record.traceId) {
        traceCorrelatedRecords.inc(labels);
      }
      const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      recordBytes.observe(bytes);
    },
  };
  return {
    registry,
    transport,
    metrics: { records, errorRecords, traceCorrelatedRecords, recordBytes },
  };
}

/** Count a record once at the logger boundary, before fan-out to transports. */
export function observeLoggerRecord(metrics: LoggerMetrics, record: LogRecord): void {
  metrics.records.inc({ level: record.level, runtime: String(record.runtime) });
}

export function updatePendingLogGauge(metrics: LoggerMetrics, pending: number): void {
  metrics.pendingLogs.set(undefined, Math.max(0, finite(pending)));
}

export function observeTransportDrop(
  metrics: LoggerMetrics,
  transport: string,
  reason: string,
  count = 1,
): void {
  metrics.transportDropped.inc({ transport, reason }, count);
}

export interface InstrumentedTransportOptions {
  transport: LogTransport;
  metrics: LoggerMetrics;
  now?: () => number;
  onMetricError?: (error: unknown, operation: string) => void;
}

function reportMetricError(
  callback: InstrumentedTransportOptions['onMetricError'],
  error: unknown,
  operation: string,
): void {
  try {
    callback?.(error, operation);
  } catch {
    // Metrics diagnostics must not create a recursive logger failure.
  }
}

/**
 * Explicit transport decorator. It observes only writes made through this
 * instance and never patches fetch, HTTP clients, console, or runtime modules.
 * Metric failures are isolated so they cannot replace the transport result.
 */
export class InstrumentedTransport implements LogTransport {
  readonly name: string;
  readonly inner: LogTransport;
  readonly metrics: LoggerMetrics;
  private readonly now: () => number;
  private readonly onMetricError: InstrumentedTransportOptions['onMetricError'];

  constructor(options: InstrumentedTransportOptions) {
    if (!options?.transport || typeof options.transport.write !== 'function') {
      throw new TypeError('InstrumentedTransport requires transport.write()');
    }
    this.inner = options.transport;
    this.metrics = options.metrics;
    this.name = options.transport.name ? `metrics:${options.transport.name}` : 'metrics:transport';
    this.now = options.now ?? (() =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
    );
    this.onMetricError = options.onMetricError;
  }

  private metric(operation: string, callback: () => void): boolean {
    try {
      callback();
      return true;
    } catch (error) {
      reportMetricError(this.onMetricError, error, operation);
      return false;
    }
  }

  async write(record: LogRecord): Promise<void> {
    const transport = this.inner.name || 'anonymous';
    const labels = { transport };
    let started: number | undefined;
    try {
      started = this.now();
    } catch (error) {
      reportMetricError(this.onMetricError, error, 'clock-start');
    }
    this.metric(
      'in-flight-inc',
      () => this.metrics.transportInFlight.inc(labels),
    );
    try {
      await this.inner.write(record);
      this.metric('write-success', () =>
        this.metrics.transportWrites.inc({ transport, outcome: 'success' }),
      );
    } catch (error) {
      this.metric('write-failure', () =>
        this.metrics.transportWrites.inc({ transport, outcome: 'failure' }),
      );
      throw error;
    } finally {
      this.metric('in-flight-dec', () => this.metrics.transportInFlight.dec(labels));
      if (started !== undefined) {
        let finished: number | undefined;
        try {
          finished = this.now();
        } catch (error) {
          reportMetricError(this.onMetricError, error, 'clock-finish');
        }
        if (finished !== undefined) {
          const elapsed = Number.isFinite(finished - started) ? Math.max(0, finished - started) : 0;
          this.metric('write-duration', () =>
            this.metrics.transportDurationSeconds.observe(labels, elapsed / 1_000),
          );
        }
      }
    }
  }

  flush(): void | Promise<void> {
    return this.inner.flush?.();
  }

  flushOnExit(records: readonly LogRecord[]): void | Promise<void> {
    return this.inner.flushOnExit?.(records);
  }

  close(): void | Promise<void> {
    return this.inner.close?.();
  }
}
