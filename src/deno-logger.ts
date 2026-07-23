import {
  BaseLogger,
  type FlushOptions,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';

export * from './base-logger.js';

export interface DenoLoggerOptions extends LoggerOptions {
  flushOnUnload?: boolean;
  shutdownTimeoutMillis?: number;
}

type DenoRuntime = {
  pid?: number;
  version?: {
    deno?: string;
    v8?: string;
    typescript?: string;
  };
};

export class DenoLogger extends BaseLogger {
  protected declare readonly options: Readonly<DenoLoggerOptions>;

  private removeUnloadHandler: (() => void) | null = null;

  constructor(options: DenoLoggerOptions = {}) {
    super(options, 'deno');
    if (options.flushOnUnload !== false && typeof globalThis.addEventListener === 'function') {
      const unload = (): void => {
        void this.flushOnExit({ timeoutMillis: options.shutdownTimeoutMillis ?? 2_000 });
      };
      globalThis.addEventListener('unload', unload);
      this.removeUnloadHandler = () => globalThis.removeEventListener('unload', unload);
    }
  }

  override getRuntimeFields(): LogFields {
    const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
    return {
      ...(deno?.pid !== undefined ? { pid: deno.pid } : {}),
      ...(deno?.version?.deno ? { denoVersion: deno.version.deno } : {}),
      ...(deno?.version?.v8 ? { v8Version: deno.version.v8 } : {}),
      ...(deno?.version?.typescript ? { typescriptVersion: deno.version.typescript } : {}),
    };
  }

  override anew(options: DenoLoggerOptions = {}): DenoLogger {
    return new DenoLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }

  override async close(options: FlushOptions = {}): Promise<void> {
    this.removeUnloadHandler?.();
    this.removeUnloadHandler = null;
    await super.close(options);
  }
}

export function createDenoLogger(options: DenoLoggerOptions = {}): DenoLogger {
  return new DenoLogger(options);
}

export const denoLogger = createDenoLogger();
export { denoLogger as logger };
export default denoLogger;
