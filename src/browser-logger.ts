import {
  BaseLogger,
  type FlushOptions,
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

export interface BrowserLoggerOptions extends LoggerOptions {
  includePageContext?: boolean;
  captureGlobalErrors?: boolean;
  captureUnhandledRejections?: boolean;
  flushOnUnload?: boolean;
  shutdownTimeoutMillis?: number;
}

const registeredBrowserLoggers = new Set<BrowserLogger>();
let unloadHandlersInstalled = false;

const flushBrowserLoggers = (): void => {
  for (const logger of registeredBrowserLoggers) {
    void logger.flushOnExit({ timeoutMillis: logger.shutdownTimeoutMillis });
  }
};

function installUnloadHandlers(): void {
  if (unloadHandlersInstalled || typeof globalThis.addEventListener !== 'function') {
    return;
  }
  unloadHandlersInstalled = true;
  globalThis.addEventListener('pagehide', flushBrowserLoggers);
  globalThis.addEventListener('beforeunload', flushBrowserLoggers);
  globalThis.addEventListener('unload', flushBrowserLoggers);
}

function removeUnloadHandlers(): void {
  if (!unloadHandlersInstalled || typeof globalThis.removeEventListener !== 'function') {
    return;
  }
  unloadHandlersInstalled = false;
  globalThis.removeEventListener('pagehide', flushBrowserLoggers);
  globalThis.removeEventListener('beforeunload', flushBrowserLoggers);
  globalThis.removeEventListener('unload', flushBrowserLoggers);
}

function registerBrowserLogger(logger: BrowserLogger): void {
  registeredBrowserLoggers.add(logger);
  installUnloadHandlers();
}

function unregisterBrowserLogger(logger: BrowserLogger): void {
  registeredBrowserLoggers.delete(logger);
  if (registeredBrowserLoggers.size === 0) {
    removeUnloadHandlers();
  }
}

export class BrowserLogger extends BaseLogger {
  protected declare readonly options: Readonly<BrowserLoggerOptions>;

  private removeGlobalHandlers: (() => void) | null = null;
  private unloadRegistered = false;

  constructor(options: BrowserLoggerOptions = {}) {
    super(options, 'browser');
    if (options.captureGlobalErrors || options.captureUnhandledRejections) {
      this.installGlobalHandlers();
    }
    if (options.flushOnUnload !== false) {
      registerBrowserLogger(this);
      this.unloadRegistered = true;
    }
  }

  get shutdownTimeoutMillis(): number {
    return this.options.shutdownTimeoutMillis ?? 2_000;
  }

  override getRuntimeFields(): LogFields {
    if (this.options.includePageContext === false) {
      return {};
    }
    return {
      ...(typeof location !== 'undefined'
        ? {
            url: location.href,
            origin: location.origin,
            path: `${location.pathname}${location.search}`,
          }
        : {}),
      ...(typeof navigator !== 'undefined'
        ? {
            userAgent: navigator.userAgent,
            language: navigator.language,
            online: navigator.onLine,
          }
        : {}),
      ...(typeof document !== 'undefined' ? { referrer: document.referrer } : {}),
    };
  }

  override anew(options: BrowserLoggerOptions = {}): BrowserLogger {
    return new BrowserLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  installGlobalHandlers(): () => void {
    if (this.removeGlobalHandlers || typeof globalThis.addEventListener !== 'function') {
      return this.removeGlobalHandlers || (() => undefined);
    }

    const errorHandler = (event: Event): void => {
      const errorEvent = event as ErrorEvent;
      void this.error(errorEvent.message || 'Unhandled browser error', errorEvent.error)
        .addFields({
          filename: errorEvent.filename,
          line: errorEvent.lineno,
          column: errorEvent.colno,
        })
        .addTags('browser', 'uncaught-error')
        .captureStackTrace()
        .send();
    };
    const rejectionHandler = (event: Event): void => {
      const rejectionEvent = event as PromiseRejectionEvent;
      void this.error('Unhandled browser promise rejection', rejectionEvent.reason)
        .addTags('browser', 'unhandled-rejection')
        .captureStackTrace()
        .send();
    };

    if (this.options.captureGlobalErrors) {
      globalThis.addEventListener('error', errorHandler);
    }
    if (this.options.captureUnhandledRejections) {
      globalThis.addEventListener('unhandledrejection', rejectionHandler);
    }

    this.removeGlobalHandlers = () => {
      if (this.options.captureGlobalErrors) {
        globalThis.removeEventListener('error', errorHandler);
      }
      if (this.options.captureUnhandledRejections) {
        globalThis.removeEventListener('unhandledrejection', rejectionHandler);
      }
      this.removeGlobalHandlers = null;
    };
    return this.removeGlobalHandlers;
  }

  installUnloadHandlers(): () => void {
    if (!this.unloadRegistered) {
      registerBrowserLogger(this);
      this.unloadRegistered = true;
    }
    return () => {
      if (this.unloadRegistered) {
        unregisterBrowserLogger(this);
        this.unloadRegistered = false;
      }
    };
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    this.removeGlobalHandlers?.();
    if (this.unloadRegistered) {
      unregisterBrowserLogger(this);
      this.unloadRegistered = false;
    }
    await super.close(options);
  }
}

export function createBrowserLogger(options: BrowserLoggerOptions = {}): BrowserLogger {
  return new BrowserLogger(options);
}

export const browserLogger = createBrowserLogger();
export { browserLogger as logger };
export default browserLogger;
