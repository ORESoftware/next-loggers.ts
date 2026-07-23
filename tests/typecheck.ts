import { logger as runtimeLogger, type LogRecord } from '@oresoftware/next-loggers';
import {
  BaseLogger,
  createLogger,
  LogEvent,
  type LogArgument,
  type LogLevel,
  type LogTransport,
} from '@oresoftware/next-loggers/base';
import {
  createBrowserLogger,
  type LoggerOptions as BrowserSharedOptions,
  type LogRecord as BrowserSharedRecord,
} from '@oresoftware/next-loggers/browser';
import {
  createBunLogger,
  type FlushOptions as BunSharedFlushOptions,
  type LogRecord as BunSharedRecord,
} from '@oresoftware/next-loggers/bun';
import {
  createDenoLogger,
  type LogTransport as DenoSharedTransport,
  type LogRecord as DenoSharedRecord,
} from '@oresoftware/next-loggers/deno';
import {
  createEdgeLogger,
  type SupabaseRealtimeOptions as EdgeSharedSupabaseOptions,
  type LogRecord as EdgeSharedRecord,
} from '@oresoftware/next-loggers/edge';
import {
  createNodeLogger,
  type HttpTransportOptions as NodeSharedHttpOptions,
  type LogRecord as NodeSharedRecord,
} from '@oresoftware/next-loggers/node';
import eslintPlugin, { requireSendRule } from '@oresoftware/next-loggers/eslint';

const transport: LogTransport = {
  write(record: LogRecord): void {
    void record.message;
  },
};

void runtimeLogger.info('root logger').send();
void createLogger({ transports: transport }).info('base').send();
void createBrowserLogger().info('browser').send();
void createEdgeLogger().info('edge').send();
void createNodeLogger().info('node').send();
void createBunLogger().info('bun').send();
void createDenoLogger().info('deno').send();
void eslintPlugin.rules['require-send'];
void requireSendRule.create;

class AuditEvent extends LogEvent {
  withActor(actor: string): this {
    this.fields.actor = actor;
    return this;
  }
}

class AuditLogger extends BaseLogger<AuditEvent> {
  constructor() {
    super({ appName: 'audit' }, 'custom-audit-runtime');
  }

  protected override createLogEvent(level: LogLevel, values: LogArgument[]): AuditEvent {
    return new AuditEvent(this, level, values);
  }
}

void new AuditLogger().info('extended').withActor('user-1').send();
