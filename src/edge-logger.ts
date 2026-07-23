import {
  BaseLogger,
  type LogEvent,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';

// Explicit named re-exports (no `export *`): keeps the shared surface identical
// and statically analyzable across Node, Bun, Deno, and bundler ESM resolvers.
export {
  BaseLogger,
  createLogger,
  DEFAULT_REDACTED_KEY_PATTERNS,
  getLogContextProvider,
  getPendingLogCount,
  HttpTransport,
  LOG_LEVELS,
  LogEvent,
  pendingLogPromises,
  r2gSmokeTest,
  serializeLogValue,
  serializeLogValueRedacted,
  setLogContextProvider,
  SupabaseRealtimeTransport,
  waitForPendingLogs,
} from './base-logger.js';
export type {
  AsyncLocalStorageLike,
  BuiltInLoggerRuntime,
  ErrorTrackingOptions,
  FlushOptions,
  HttpTransportOptions,
  LogArgument,
  LogContext,
  LogContextProvider,
  LogFields,
  LoggerOptions,
  LoggerRuntime,
  LogLevel,
  LogRecord,
  LogTransport,
  LogUser,
  SerializedValue,
  SupabaseRealtimeOptions,
  WebSocketFactory,
  WebSocketLike,
} from './base-logger.js';

export interface EdgeExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface EdgeLoggerOptions extends LoggerOptions {
  executionContext?: EdgeExecutionContextLike;
  request?: Request;
}

export class EdgeLogger extends BaseLogger {
  protected declare readonly options: Readonly<EdgeLoggerOptions>;

  constructor(options: EdgeLoggerOptions = {}) {
    super(options, 'edge');
  }

  override getRuntimeFields(): LogFields {
    const request = this.options.request;
    return request
      ? {
          requestUrl: request.url,
          requestMethod: request.method,
        }
      : {};
  }

  override emitEvent(event: LogEvent, store = true): Promise<void> {
    const promise = super.emitEvent(event, store);
    try {
      this.options.executionContext?.waitUntil(promise);
    } catch (error) {
      this.options.onLifecycleError?.(error, 'waitUntil');
    }
    return promise;
  }

  override anew(options: EdgeLoggerOptions = {}): EdgeLogger {
    return new EdgeLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }
}

export function createEdgeLogger(options: EdgeLoggerOptions = {}): EdgeLogger {
  return new EdgeLogger(options);
}

export const edgeLogger = createEdgeLogger();
export { edgeLogger as logger };
export default edgeLogger;
