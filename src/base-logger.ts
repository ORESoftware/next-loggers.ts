export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogArgument = unknown;
export type LogFields = Record<string, unknown>;
export type BuiltInLoggerRuntime = 'base' | 'browser' | 'edge' | 'node' | 'bun' | 'deno';
export type LoggerRuntime = BuiltInLoggerRuntime | (string & Record<never, never>);

export interface LogUser extends LogFields {
  id?: string;
  email?: string;
  ddUserId?: string;
  clerkUserId?: string;
  supabaseAuthUserId?: string;
  firstName?: string;
  lastName?: string;
}

export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | { [key: string]: SerializedValue };

export interface LogRecord {
  schema: 'next-loggers/v1';
  id: string;
  timestamp: string;
  level: LogLevel;
  runtime: LoggerRuntime;
  appName: string;
  name?: string;
  message: string;
  values: SerializedValue[];
  fields: Record<string, SerializedValue>;
  loggedInUser?: Record<string, SerializedValue>;
  users?: Array<Record<string, SerializedValue>>;
  traceId?: string;
  traceIds?: string[];
  routineId?: string;
  tags?: string[];
  context?: SerializedValue[];
  meta?: SerializedValue[];
  errors?: SerializedValue[];
  stackTrace?: string[];
}

export interface LogTransport {
  readonly name?: string;
  write(record: LogRecord): void | Promise<void>;
  flush?(): void | Promise<void>;
  flushOnExit?(records: readonly LogRecord[]): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface HttpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMillis?: number;
  fetch?: typeof fetch;
  mapBody?: (record: LogRecord) => BodyInit;
  keepalive?: boolean;
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SupabaseRealtimeOptions {
  /** A Supabase project URL or a complete Realtime WebSocket URL. */
  url: string;
  /** The publishable/anon key used to connect to Supabase Realtime. */
  anonKey: string;
  /** A user JWT. When omitted, the anon key is used as the access token. */
  accessToken?: string;
  channel?: string;
  event?: string;
  maxQueueSize?: number;
  connectTimeoutMillis?: number;
  heartbeatMillis?: number;
  reconnect?: boolean;
  webSocketFactory?: WebSocketFactory;
}

export interface LoggerOptions {
  appName?: string;
  name?: string;
  maxLevel?: LogLevel | Lowercase<LogLevel>;
  fields?: LogFields;
  loggedInUser?: LogUser;
  console?: boolean;
  autoSend?: boolean;
  transports?: LogTransport | LogTransport[];
  http?: HttpTransportOptions;
  supabase?: SupabaseRealtimeOptions;
  onTransportError?: (error: unknown, transport: LogTransport, record: LogRecord) => void;
  /** Attach delivery to a request lifecycle, such as an Edge execution context. */
  waitUntil?: (promise: Promise<void>) => void;
  /** Attach delivery to Next.js `after()`, without importing Next.js into this package. */
  after?: (callback: () => Promise<void>) => void;
  onLifecycleError?: (error: unknown, hook: 'waitUntil' | 'after') => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface FlushOptions {
  timeoutMillis?: number;
  sendUnsent?: boolean;
}

/** All in-flight writes, shared across logger instances like a small dd-proms registry. */
export const pendingLogPromises = new Set<Promise<void>>();

export function getPendingLogCount(): number {
  return pendingLogPromises.size;
}

async function waitWithTimeout(promise: Promise<void>, timeoutMillis?: number): Promise<void> {
  if (!timeoutMillis) {
    await promise;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMillis);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForPendingLogs(options: FlushOptions = {}): Promise<void> {
  const settle = Promise.allSettled(Array.from(pendingLogPromises)).then(() => undefined);
  await waitWithTimeout(settle, options.timeoutMillis);
}

const CONSOLE_METHODS: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
};

const LEVEL_INDEX = new Map<LogLevel, number>(LOG_LEVELS.map((level, index) => [level, index]));

function normalizeLevel(level: LogLevel | Lowercase<LogLevel> | undefined): LogLevel {
  const normalized = String(level || 'INFO').toUpperCase() as LogLevel;
  return LEVEL_INDEX.has(normalized) ? normalized : 'INFO';
}

function randomId(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function serializeError(error: Error, seen: WeakSet<object>): Record<string, SerializedValue> {
  const result: Record<string, SerializedValue> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) {
    result.stack = error.stack;
  }
  const errorWithCause = error as Error & { cause?: unknown };
  if (errorWithCause.cause !== undefined) {
    result.cause = serialize(errorWithCause.cause, seen);
  }
  for (const key of Object.keys(error)) {
    result[key] = serialize((error as unknown as Record<string, unknown>)[key], seen);
  }
  return result;
}

function serialize(value: unknown, seen: WeakSet<object>): SerializedValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  try {
    if (value instanceof Error) {
      return serializeError(value, seen);
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    if (value instanceof RegExp) {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => serialize(item, seen));
    }
    if (value instanceof Map) {
      return Array.from(value.entries(), ([key, entryValue]) => [
        serialize(key, seen),
        serialize(entryValue, seen),
      ]);
    }
    if (value instanceof Set) {
      return Array.from(value, (entryValue) => serialize(entryValue, seen));
    }

    const result: Record<string, SerializedValue> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      try {
        result[key] = serialize(entryValue, seen);
      } catch (error) {
        result[key] = `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName && constructorName !== 'Object') {
      result.__type = constructorName;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function serializeLogValue(value: unknown): SerializedValue {
  return serialize(value, new WeakSet<object>());
}

function toMessagePart(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(serializeLogValue(value));
  } catch {
    return String(value);
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `log-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError(`Supabase Realtime requires an http(s) or ws(s) URL, got ${parsed.protocol}`);
  }
  if (!parsed.pathname.endsWith('/websocket')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/realtime/v1/websocket`;
  }
  return parsed.toString();
}

export class HttpTransport implements LogTransport {
  readonly name = 'http';
  readonly options: Readonly<HttpTransportOptions>;

  constructor(options: HttpTransportOptions) {
    this.options = options;
  }

  async write(record: LogRecord): Promise<void> {
    const fetchImplementation = this.options.fetch || globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new Error('No fetch implementation is available for HttpTransport');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMillis ?? 15_000);
    try {
      const response = await fetchImplementation(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body: this.options.mapBody?.(record) ?? JSON.stringify(record),
        signal: controller.signal,
        redirect: 'follow',
        keepalive: this.options.keepalive ?? true,
      });
      if (!response.ok) {
        throw new Error(`Log endpoint returned ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  flushOnExit(records: readonly LogRecord[]): void {
    const beacon =
      this.options.sendBeacon ||
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : undefined);
    if (!beacon) {
      return;
    }
    for (const record of records) {
      const body = this.options.mapBody?.(record) ?? JSON.stringify(record);
      try {
        beacon(this.options.endpoint, body);
      } catch {
        // The original keepalive fetch remains the fallback.
      }
    }
  }
}

type PhoenixMessage = {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string;
  join_ref?: string;
};

export class SupabaseRealtimeTransport implements LogTransport {
  readonly name = 'supabase-realtime';
  readonly options: Readonly<SupabaseRealtimeOptions>;

  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private queue: PhoenixMessage[] = [];
  private joined = false;
  private joinRef = '';
  private closed = false;
  private ref = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(options: SupabaseRealtimeOptions) {
    this.options = options;
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private get topic(): string {
    return `realtime:${this.options.channel || 'next-loggers'}`;
  }

  private createSocket(): WebSocketLike {
    const factory = this.options.webSocketFactory || ((url: string) => {
      const WebSocketConstructor = (globalThis as { WebSocket?: new (value: string) => WebSocketLike })
        .WebSocket;
      if (!WebSocketConstructor) {
        throw new Error(
          'No WebSocket implementation is available. Pass supabase.webSocketFactory in this runtime.',
        );
      }
      return new WebSocketConstructor(url);
    });

    const url = new URL(normalizeUrl(this.options.url));
    url.searchParams.set('apikey', this.options.anonKey);
    url.searchParams.set('vsn', '1.0.0');
    return factory(url.toString());
  }

  private sendRaw(message: PhoenixMessage): void {
    if (!this.socket || this.socket.readyState !== 1 || !this.joined) {
      throw new Error('Supabase Realtime channel is not connected');
    }
    this.socket.send(JSON.stringify(message));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === 1) {
        this.socket.send(
          JSON.stringify({
            topic: 'phoenix',
            event: 'heartbeat',
            payload: {},
            ref: this.nextRef(),
          }),
        );
      }
    }, this.options.heartbeatMillis ?? 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private enqueue(message: PhoenixMessage): void {
    const maximum = Math.max(1, this.options.maxQueueSize ?? 500);
    if (this.queue.length >= maximum) {
      this.queue.shift();
    }
    this.queue.push(message);
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.socket?.readyState === 1 && this.joined) {
      const message = this.queue.shift();
      if (!message) {
        return;
      }
      try {
        message.join_ref = this.joinRef;
        this.sendRaw(message);
      } catch {
        this.queue.unshift(message);
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.options.reconnect === false || this.queue.length === 0) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Supabase Realtime transport is closed'));
    }
    if (this.socket?.readyState === 1 && this.joined) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    let socket: WebSocketLike;
    try {
      socket = this.createSocket();
    } catch (error) {
      return Promise.reject(error);
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      this.socket = socket;
      this.joined = false;
      this.joinRef = '';
      const timeout = setTimeout(() => finish(new Error('Supabase Realtime connection timed out')),
        this.options.connectTimeoutMillis ?? 8_000,
      );

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        if (error) {
          if (socket.readyState === 0 || socket.readyState === 1) {
            socket.close(1011, error.message.slice(0, 120));
          }
          reject(error);
        } else {
          resolve();
        }
      };

      socket.onopen = () => {
        const ref = this.nextRef();
        this.joinRef = ref;
        const accessToken = this.options.accessToken || this.options.anonKey;
        socket.send(
          JSON.stringify({
            topic: this.topic,
            event: 'phx_join',
            payload: {
              config: {
                broadcast: { ack: true, self: false },
                presence: { enabled: false },
                postgres_changes: [],
                private: false,
              },
              access_token: accessToken,
            },
            ref,
            join_ref: ref,
          }),
        );
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            topic?: string;
            event?: string;
            payload?: { status?: string };
          };
          if (
            message.topic === this.topic &&
            message.event === 'phx_reply' &&
            message.payload?.status === 'ok'
          ) {
            this.joined = true;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            this.startHeartbeat();
            this.drainQueue();
            finish();
          } else if (
            message.topic === this.topic &&
            message.event === 'phx_reply' &&
            message.payload?.status === 'error' &&
            !this.joined
          ) {
            finish(new Error('Supabase Realtime rejected the channel join'));
          } else if (
            message.topic === this.topic &&
            (message.event === 'phx_error' || message.event === 'phx_close')
          ) {
            socket.close(1011, `Supabase Realtime sent ${message.event}`);
          }
        } catch {
          // Ignore messages not owned by this transport.
        }
      };

      socket.onerror = () => finish(new Error('Supabase Realtime WebSocket error'));
      socket.onclose = () => {
        this.joined = false;
        this.joinRef = '';
        this.stopHeartbeat();
        if (!settled) {
          finish(new Error('Supabase Realtime WebSocket closed before joining'));
        }
        this.scheduleReconnect();
      };
    });

    return this.connectPromise;
  }

  async write(record: LogRecord): Promise<void> {
    const ref = this.nextRef();
    const message: PhoenixMessage = {
      topic: this.topic,
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: this.options.event || 'log',
        payload: record,
      },
      ref,
      join_ref: this.joinRef,
    };

    try {
      await this.connect();
      message.join_ref = this.joinRef;
      this.sendRaw(message);
    } catch (error) {
      this.enqueue(message);
      this.scheduleReconnect();
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    await this.connect();
    this.drainQueue();
    if (this.queue.length > 0) {
      throw new Error(`${this.queue.length} Supabase Realtime log messages remain queued`);
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'next-loggers transport closed');
    this.socket = null;
    this.joined = false;
    this.joinRef = '';
    this.reconnectAttempts = 0;
  }
}

export class LogEvent {
  readonly logger: BaseLogger;
  readonly level: LogLevel;
  readonly values: LogArgument[];

  protected fields: LogFields = {};
  protected loggedInUser: LogUser = {};
  protected users: LogUser[] = [];
  protected traceId = '';
  protected traceIds = new Set<string>();
  protected routineId = '';
  protected tags = new Set<string>();
  protected context: LogArgument[] = [];
  protected meta: LogArgument[] = [];
  protected stackTrace: string[] = [];
  protected sendPromise: Promise<void> | null = null;
  protected record: LogRecord | null = null;

  constructor(logger: BaseLogger, level: LogLevel, values: LogArgument[]) {
    this.logger = logger;
    this.level = level;
    this.values = values;
  }

  addFields(fields: LogFields): this {
    Object.assign(this.fields, fields);
    return this;
  }

  addTrace(id: string, options?: { makeFirst?: boolean }): this {
    const value = String(id || '').trim();
    if (!value) {
      return this;
    }
    if (!this.traceId || options?.makeFirst) {
      this.traceId = value;
    }
    this.traceIds.add(value);
    return this;
  }

  addTraceId(id: string, options?: { makeFirst?: boolean }): this {
    return this.addTrace(id, options);
  }

  addRoutineId(id: string): this {
    this.routineId = String(id || '');
    return this;
  }

  addTags(...tags: string[]): this {
    for (const tag of tags) {
      const value = String(tag || '').trim();
      if (value) {
        this.tags.add(value);
      }
    }
    return this;
  }

  addTagList(tags: string[]): this {
    return this.addTags(...tags);
  }

  addContext(value: LogArgument): this {
    this.context.push(value);
    return this;
  }

  addMeta(value: LogArgument): this {
    this.meta.push(value);
    return this;
  }

  addLoggedInUserInfo(user: LogUser): this {
    Object.assign(this.loggedInUser, user);
    return this;
  }

  addLoggedInUserId(id: string): this {
    this.loggedInUser.id = id;
    return this;
  }

  addUserInfo(user: LogUser): this {
    this.users.push(user);
    return this;
  }

  setUserContext(user: { ddUserId: string }, userInfo?: LogUser): this {
    if (userInfo) {
      this.addUserInfo(userInfo);
    }
    return this.addLoggedInUserInfo({ ...userInfo, ddUserId: user.ddUserId });
  }

  captureStackTrace(message = 'next-loggers stack trace'): this {
    const stack = new Error(message).stack;
    if (stack) {
      this.stackTrace.push(
        ...stack
          .split('\n')
          .filter((line) => line && !line.includes('node_modules/next-loggers')),
      );
    }
    return this;
  }

  getHashCode(): string {
    return hashString(
      JSON.stringify([
        this.level,
        this.logger.runtime,
        this.values.map(serializeLogValue),
        Array.from(this.traceIds),
      ]),
    );
  }

  toJSON(now = this.logger.now().toISOString()): LogRecord {
    if (this.record) {
      return this.record;
    }

    const errors = this.values.filter((value) => value instanceof Error).map(serializeLogValue);
    const loggerUser = this.logger.getCurrentUser();
    const loggedInUser = { ...loggerUser, ...this.loggedInUser };
    const traces = Array.from(this.traceIds);
    const fields = { ...this.logger.fields, ...this.fields, ...this.logger.getRuntimeFields() };
    this.record = {
      schema: 'next-loggers/v1',
      id: this.logger.createId(),
      timestamp: now,
      level: this.level,
      runtime: this.logger.runtime,
      appName: this.logger.appName,
      ...(this.logger.name ? { name: this.logger.name } : {}),
      message: this.values.map(toMessagePart).join(' '),
      values: this.values.map(serializeLogValue),
      fields: serializeLogValue(fields) as Record<string, SerializedValue>,
      ...(Object.keys(loggedInUser).length > 0
        ? { loggedInUser: serializeLogValue(loggedInUser) as Record<string, SerializedValue> }
        : {}),
      ...(this.users.length > 0
        ? {
            users: this.users.map(
              (user) => serializeLogValue(user) as Record<string, SerializedValue>,
            ),
          }
        : {}),
      ...(this.traceId ? { traceId: this.traceId } : {}),
      ...(traces.length > 0 ? { traceIds: traces } : {}),
      ...(this.routineId ? { routineId: this.routineId } : {}),
      ...(this.tags.size > 0 ? { tags: Array.from(this.tags) } : {}),
      ...(this.context.length > 0 ? { context: this.context.map(serializeLogValue) } : {}),
      ...(this.meta.length > 0 ? { meta: this.meta.map(serializeLogValue) } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(this.stackTrace.length > 0 ? { stackTrace: this.stackTrace } : {}),
    };
    return this.record;
  }

  getJSON(options?: { now?: string }): string {
    return JSON.stringify(this.toJSON(options?.now));
  }

  send(store = true): Promise<void> {
    this.sendPromise ??= this.logger.emitEvent(this, store);
    return this.sendPromise;
  }
}

export class BaseLogger<TEvent extends LogEvent = LogEvent> {
  readonly runtime: LoggerRuntime;
  readonly appName: string;
  readonly name: string | undefined;
  readonly maxLevel: LogLevel;
  readonly fields: LogFields;

  protected readonly options: Readonly<LoggerOptions>;
  protected readonly transports: LogTransport[];

  protected currentUser: LogUser;
  protected pending = new Set<Promise<void>>();
  protected unsentEvents = new Set<LogEvent>();
  protected activeRecords = new Set<LogRecord>();

  constructor(options: LoggerOptions = {}, runtime: LoggerRuntime = 'base') {
    this.options = options;
    this.runtime = runtime;
    this.appName = options.appName || 'app';
    this.name = options.name;
    this.maxLevel = normalizeLevel(options.maxLevel);
    this.fields = { ...options.fields };
    this.currentUser = { ...options.loggedInUser };
    this.transports = options.transports
      ? Array.isArray(options.transports)
        ? [...options.transports]
        : [options.transports]
      : [];
    if (options.http) {
      this.transports.push(new HttpTransport(options.http));
    }
    if (options.supabase) {
      this.transports.push(new SupabaseRealtimeTransport(options.supabase));
    }
  }

  now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  createId(): string {
    return this.options.idFactory?.() ?? randomId();
  }

  getCurrentUser(): LogUser {
    return { ...this.currentUser };
  }

  getRuntimeFields(): LogFields {
    return {};
  }

  setCurrentUser(user: LogUser): this {
    this.currentUser = { ...this.currentUser, ...user };
    return this;
  }

  addFields(fields: LogFields): this {
    Object.assign(this.fields, fields);
    return this;
  }

  addRoutineId(id: string): this {
    this.fields.routineId = id;
    return this;
  }

  getLogLevel(): LogLevel {
    return this.maxLevel;
  }

  anew(options: LoggerOptions = {}): BaseLogger<TEvent> {
    return new BaseLogger<TEvent>(
      {
        ...this.options,
        ...options,
        appName: options.appName || this.appName,
        fields: { ...this.fields, ...options.fields },
        loggedInUser: { ...this.currentUser, ...options.loggedInUser },
      },
      this.runtime,
    );
  }

  protected createLogEvent(level: LogLevel, values: LogArgument[]): TEvent {
    return new LogEvent(this, level, values) as TEvent;
  }

  protected createEvent(level: LogLevel, values: LogArgument[]): TEvent {
    const event = this.createLogEvent(level, values);
    this.unsentEvents.add(event);
    if (this.options.autoSend) {
      queueMicrotask(() => void event.send());
    }
    return event;
  }

  trace(...values: LogArgument[]): TEvent {
    return this.createEvent('TRACE', values);
  }

  debug(...values: LogArgument[]): TEvent {
    return this.createEvent('DEBUG', values);
  }

  info(...values: LogArgument[]): TEvent {
    return this.createEvent('INFO', values);
  }

  log(...values: LogArgument[]): TEvent {
    return this.info(...values);
  }

  warn(...values: LogArgument[]): TEvent {
    return this.createEvent('WARN', values);
  }

  error(...values: LogArgument[]): TEvent {
    return this.createEvent('ERROR', values);
  }

  fatal(...values: LogArgument[]): TEvent {
    return this.createEvent('FATAL', values);
  }

  protected isEnabled(level: LogLevel): boolean {
    return (LEVEL_INDEX.get(level) ?? 0) >= (LEVEL_INDEX.get(this.maxLevel) ?? 2);
  }

  protected writeConsole(record: LogRecord): void {
    const method = CONSOLE_METHODS[record.level];
    const prefix = `[${record.timestamp}] [${record.level}] [${record.appName}]`;
    const consoleMethod = console[method] || console.log;
    consoleMethod(prefix, ...record.values);
  }

  emitEvent(event: LogEvent, store = true): Promise<void> {
    this.unsentEvents.delete(event);
    if (!this.isEnabled(event.level)) {
      return Promise.resolve();
    }

    const record = event.toJSON();
    this.activeRecords.add(record);
    const task = (async () => {
      if (this.options.console !== false) {
        this.writeConsole(record);
      }
      if (!store) {
        return;
      }
      const results = await Promise.allSettled(
        this.transports.map(async (transport) => transport.write(record)),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result?.status === 'rejected') {
          const transport = this.transports[index];
          if (transport) {
            if (this.options.onTransportError) {
              this.options.onTransportError(result.reason, transport, record);
            } else if (this.options.console !== false) {
              console.error(`[next-loggers] ${transport.name || 'transport'} failed`, result.reason);
            }
          }
        }
      }
    })();

    this.pending.add(task);
    pendingLogPromises.add(task);
    const cleanup = (): void => {
      this.pending.delete(task);
      pendingLogPromises.delete(task);
      this.activeRecords.delete(record);
    };
    void task.then(cleanup, cleanup);
    try {
      this.options.waitUntil?.(task);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'waitUntil');
    }
    try {
      this.options.after?.(async () => task);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'after');
    }
    return task;
  }

  async flush(options: FlushOptions = {}): Promise<void> {
    if (options.sendUnsent) {
      await Promise.allSettled(Array.from(this.unsentEvents, async (event) => event.send()));
    }
    const settle = async (): Promise<void> => {
      await Promise.allSettled(Array.from(this.pending));
      await Promise.allSettled(this.transports.map(async (transport) => transport.flush?.()));
    };
    await waitWithTimeout(settle(), options.timeoutMillis);
  }

  async flushOnExit(options: FlushOptions = {}): Promise<void> {
    for (const event of Array.from(this.unsentEvents)) {
      void event.send();
    }
    const records = Array.from(this.activeRecords);
    const exitTasks = this.transports.map(async (transport) => transport.flushOnExit?.(records));
    const settle = Promise.allSettled([
      this.flush({ ...options, sendUnsent: true }),
      ...exitTasks,
    ]).then(() => undefined);
    await waitWithTimeout(settle, options.timeoutMillis);
  }

  async close(options: FlushOptions = {}): Promise<void> {
    await this.flushOnExit(options);
    await Promise.allSettled(this.transports.map(async (transport) => transport.close?.()));
  }
}

export function createLogger(options: LoggerOptions = {}): BaseLogger {
  return new BaseLogger(options);
}

export const logger = createLogger();
export default logger;
