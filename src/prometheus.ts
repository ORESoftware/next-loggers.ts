import type { LogLevel, LogRecord, LogTransport } from './base-logger.js';

export type PrometheusLabels = Readonly<Record<string, string | number | boolean>>;

export interface PrometheusRegistryOptions {
  /** Maximum unique label sets retained per metric. Default 1000. */
  maxSeriesPerMetric?: number;
  /** Prefix applied to every application metric. Default next_loggers. */
  prefix?: string;
}

export interface CounterOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export interface GaugeOptions extends CounterOptions {}

export interface HistogramOptions extends CounterOptions {
  /** Strictly increasing finite upper bounds. */
  buckets?: readonly number[];
}

interface NormalizedLabels {
  key: string;
  values: Readonly<Record<string, string>>;
}

interface MetricDescriptor {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly maximumSeries: number;
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateName(name: string, pattern: RegExp, label: string): string {
  if (!pattern.test(name)) {
    throw new TypeError(`${label} is not a valid Prometheus identifier: ${name}`);
  }
  return name;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelsText(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function numberText(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '+Inf';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }
  return String(value);
}

function normalizeLabelNames(labelNames: readonly string[] | undefined): readonly string[] {
  const names = [...(labelNames ?? [])];
  const seen = new Set<string>();
  for (const name of names) {
    validateName(name, LABEL_NAME, 'label name');
    if (name === 'le') {
      throw new TypeError('label name le is reserved for histogram buckets');
    }
    if (seen.has(name)) {
      throw new TypeError(`duplicate Prometheus label name: ${name}`);
    }
    seen.add(name);
  }
  return names;
}

function normalizeLabels(
  labelNames: readonly string[],
  labels: PrometheusLabels | undefined,
): NormalizedLabels {
  const source = labels ?? {};
  const sourceKeys = Object.keys(source);
  for (const key of sourceKeys) {
    if (!labelNames.includes(key)) {
      throw new TypeError(`unexpected Prometheus label ${key}`);
    }
  }
  const values: Record<string, string> = {};
  for (const name of labelNames) {
    const value = source[name];
    if (value === undefined) {
      throw new TypeError(`missing Prometheus label ${name}`);
    }
    values[name] = String(value);
  }
  return {
    key: labelNames.map((name) => `${name}\u0000${values[name]}`).join('\u0001'),
    values,
  };
}

abstract class MetricBase {
  readonly descriptor: MetricDescriptor;
  protected readonly dropped: (metricName: string) => void;

  protected constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    this.descriptor = descriptor;
    this.dropped = dropped;
  }

  abstract render(): string[];
}

export class PrometheusCounter extends MetricBase {
  private readonly series = new Map<string, { labels: Readonly<Record<string, string>>; value: number }>();

  constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    super(descriptor, dropped);
  }

  add(value = 1, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Prometheus counters can only increase by a finite non-negative value');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value += value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  inc(labels?: PrometheusLabels): void {
    this.add(1, labels);
  }

  render(): string[] {
    return Array.from(this.series.values(), ({ labels, value }) =>
      `${this.descriptor.name}${labelsText(labels)} ${numberText(value)}`,
    );
  }
}

export class PrometheusGauge extends MetricBase {
  private readonly series = new Map<string, { labels: Readonly<Record<string, string>>; value: number }>();

  constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    super(descriptor, dropped);
  }

  set(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus gauges require a finite value');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value = value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  add(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus gauges require a finite delta');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value += value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  inc(labels?: PrometheusLabels): void {
    this.add(1, labels);
  }

  dec(labels?: PrometheusLabels): void {
    this.add(-1, labels);
  }

  render(): string[] {
    return Array.from(this.series.values(), ({ labels, value }) =>
      `${this.descriptor.name}${labelsText(labels)} ${numberText(value)}`,
    );
  }
}

interface HistogramSeries {
  labels: Readonly<Record<string, string>>;
  buckets: number[];
  count: number;
  sum: number;
}

export class PrometheusHistogram extends MetricBase {
  readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    descriptor: MetricDescriptor,
    buckets: readonly number[],
    dropped: (metricName: string) => void,
  ) {
    super(descriptor, dropped);
    this.buckets = buckets;
  }

  observe(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus histograms require a finite observation');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    let series = this.series.get(normalized.key);
    if (!series) {
      if (this.series.size >= this.descriptor.maximumSeries) {
        this.dropped(this.descriptor.name);
        return;
      }
      series = {
        labels: normalized.values,
        buckets: this.buckets.map(() => 0),
        count: 0,
        sum: 0,
      };
      this.series.set(normalized.key, series);
    }
    series.count += 1;
    series.sum += value;
    for (let index = 0; index < this.buckets.length; index += 1) {
      const boundary = this.buckets[index];
      if (boundary !== undefined && value <= boundary) {
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      }
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (const series of this.series.values()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        const boundary = this.buckets[index];
        if (boundary === undefined) {
          continue;
        }
        lines.push(
          `${this.descriptor.name}_bucket${labelsText({
            ...series.labels,
            le: numberText(boundary),
          })} ${series.buckets[index] ?? 0}`,
        );
      }
      lines.push(
        `${this.descriptor.name}_bucket${labelsText({ ...series.labels, le: '+Inf' })} ${series.count}`,
      );
      lines.push(`${this.descriptor.name}_sum${labelsText(series.labels)} ${numberText(series.sum)}`);
      lines.push(`${this.descriptor.name}_count${labelsText(series.labels)} ${series.count}`);
    }
    return lines;
  }
}

const DEFAULT_BUCKETS = [64, 256, 1_024, 4_096, 16_384, 65_536, 262_144] as const;

export class PrometheusRegistry {
  readonly prefix: string;
  readonly maxSeriesPerMetric: number;
  private readonly metrics = new Map<string, MetricBase>();
  private readonly droppedSeries = new Map<string, number>();

  constructor(options: PrometheusRegistryOptions = {}) {
    this.prefix = options.prefix ?? 'next_loggers';
    validateName(this.prefix, /^[a-zA-Z_:][a-zA-Z0-9_:]*$/, 'metric prefix');
    this.maxSeriesPerMetric = Math.max(1, Math.floor(options.maxSeriesPerMetric ?? 1_000));
  }

  private descriptor(options: CounterOptions): MetricDescriptor {
    const rawName = validateName(options.name, METRIC_NAME, 'metric name');
    const name = rawName.startsWith(`${this.prefix}_`) ? rawName : `${this.prefix}_${rawName}`;
    return {
      name,
      help: options.help,
      labelNames: normalizeLabelNames(options.labelNames),
      maximumSeries: this.maxSeriesPerMetric,
    };
  }

  private register<T extends MetricBase>(metric: T): T {
    if (this.metrics.has(metric.descriptor.name)) {
      throw new TypeError(`Prometheus metric already registered: ${metric.descriptor.name}`);
    }
    this.metrics.set(metric.descriptor.name, metric);
    return metric;
  }

  private noteDrop = (metricName: string): void => {
    this.droppedSeries.set(metricName, (this.droppedSeries.get(metricName) ?? 0) + 1);
  };

  counter(options: CounterOptions): PrometheusCounter {
    return this.register(new PrometheusCounter(this.descriptor(options), this.noteDrop));
  }

  gauge(options: GaugeOptions): PrometheusGauge {
    return this.register(new PrometheusGauge(this.descriptor(options), this.noteDrop));
  }

  histogram(options: HistogramOptions): PrometheusHistogram {
    const buckets = [...(options.buckets ?? DEFAULT_BUCKETS)];
    if (
      buckets.length === 0 ||
      buckets.some((bucket) => !Number.isFinite(bucket)) ||
      buckets.some((bucket, index) => index > 0 && bucket <= (buckets[index - 1] ?? bucket))
    ) {
      throw new TypeError('Prometheus histogram buckets must be finite and strictly increasing');
    }
    return this.register(
      new PrometheusHistogram(this.descriptor(options), buckets, this.noteDrop),
    );
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of Array.from(this.metrics.values()).sort((a, b) =>
      a.descriptor.name.localeCompare(b.descriptor.name),
    )) {
      lines.push(`# HELP ${metric.descriptor.name} ${escapeHelp(metric.descriptor.help)}`);
      const type = metric instanceof PrometheusCounter
        ? 'counter'
        : metric instanceof PrometheusGauge
          ? 'gauge'
          : 'histogram';
      lines.push(`# TYPE ${metric.descriptor.name} ${type}`);
      lines.push(...metric.render());
    }
    if (this.droppedSeries.size > 0) {
      const metricName = `${this.prefix}_prometheus_dropped_series_total`;
      lines.push(`# HELP ${metricName} Label sets dropped by the in-process cardinality guard.`);
      lines.push(`# TYPE ${metricName} counter`);
      for (const [name, value] of Array.from(this.droppedSeries).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${metricName}{metric="${escapeLabel(name)}"} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  response(init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    }
    headers.set('cache-control', 'no-store');
    return new Response(this.render(), { ...init, headers });
  }
}

export interface LoggerPrometheusTransportOptions {
  registry?: PrometheusRegistry;
  /** Stable deployment/environment label. Avoid request IDs or user IDs. */
  environment?: string;
  recordSizeBuckets?: readonly number[];
}

export interface LoggerPrometheusMetrics {
  readonly registry: PrometheusRegistry;
  readonly transport: LogTransport;
}

function utf8Length(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

export function createLoggerPrometheusMetrics(
  options: LoggerPrometheusTransportOptions = {},
): LoggerPrometheusMetrics {
  const registry = options.registry ?? new PrometheusRegistry();
  const labels = ['app_name', 'runtime', 'level', ...(options.environment ? ['environment'] : [])];
  const records = registry.counter({
    name: 'records_total',
    help: 'Structured log records emitted by next-loggers.',
    labelNames: labels,
  });
  const errors = registry.counter({
    name: 'error_records_total',
    help: 'ERROR and FATAL records emitted by next-loggers.',
    labelNames: labels,
  });
  const correlated = registry.counter({
    name: 'trace_correlated_records_total',
    help: 'Records carrying a trace identifier.',
    labelNames: labels,
  });
  const bytes = registry.histogram({
    name: 'record_bytes',
    help: 'Serialized structured log record size in bytes.',
    labelNames: labels,
    ...(options.recordSizeBuckets ? { buckets: options.recordSizeBuckets } : {}),
  });
  const labelValues = (record: LogRecord): PrometheusLabels => ({
    app_name: record.appName,
    runtime: record.runtime,
    level: record.level,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  return {
    registry,
    transport: {
      name: 'prometheus-metrics',
      write(record) {
        const values = labelValues(record);
        records.inc(values);
        bytes.observe(utf8Length(JSON.stringify(record)), values);
        if (record.traceId) {
          correlated.inc(values);
        }
        if (record.level === 'ERROR' || record.level === 'FATAL') {
          errors.inc(values);
        }
      },
    },
  };
}

export function isErrorLevel(level: LogLevel): boolean {
  return level === 'ERROR' || level === 'FATAL';
}
