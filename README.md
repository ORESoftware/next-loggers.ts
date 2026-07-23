# @oresoftware/next-loggers

Dependency-free, ESM-only loggers for Next.js, browsers, edge workers, Node.js, Bun, and Deno. Log events are chainable, safely serialized, and can be sent to HTTP endpoints or streamed over Supabase Realtime WebSockets.

## Install

```sh
npm install @oresoftware/next-loggers
```

The package intentionally does not ship a CommonJS build. It works from `.mjs` files and ESM TypeScript projects.

## Runtime entry points

The root import uses package export conditions. Next.js can select `browser`, `edge-light`, or `node`; Deno and Bun select their own conditions.

```ts
import { logger } from '@oresoftware/next-loggers';
```

The root covers every shipped runtime: `browser`, `edge-light`/`workerd`/`worker`, `deno`, `bun`, and `node`, followed by the universal base fallback. Every runtime entry re-exports the base contracts and classes.

Explicit entry points are also available and are recommended when the runtime is known:

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import { createBunLogger } from '@oresoftware/next-loggers/bun';
import { createDenoLogger } from '@oresoftware/next-loggers/deno';
import { createLogger } from '@oresoftware/next-loggers/base';
```

## Basic use

```ts
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const log = createNodeLogger({
  appName: 'checkout-api',
  maxLevel: 'info',
  fields: { service: 'checkout' },
});

await log
  .error('Payment failed', new Error('card declined'))
  .addTrace('trace-123', { makeFirst: true })
  .addRoutineId('charge-card')
  .addTags('payments', 'stripe')
  .addFields({ orderId: 'order-42' })
  .addContext({ attempt: 2 })
  .send();

await log.flush({ timeoutMillis: 2_000 });
```

Circular references, errors, dates, bigints, maps, sets, functions, and symbols are normalized before transport.

## ESLint: require `.send()`

The ESM-only ESLint plugin supports ESLint 9 and 10 flat config. Its recommended rule warns when a standalone logger chain forgets `.send()`:

```js
// eslint.config.mjs
import nextLoggers from '@oresoftware/next-loggers/eslint';

export default [nextLoggers.configs.recommended];
```

```ts
log.info('foo'); // warning: Call .send() on this log event
log.info('foo').addFields({ orderId }).send(); // okay
```

The rule recognizes package singleton imports, default imports, namespace imports, logger factories, exported logger classes, and the common names `log`, `logger`, and `ddlog`. Configure additional application-specific names directly:

```js
import nextLoggers from '@oresoftware/next-loggers/eslint';

export default [
  {
    plugins: { 'next-loggers': nextLoggers },
    rules: {
      'next-loggers/require-send': ['warn', { loggerNames: ['audit', 'telemetry'] }],
    },
  },
];
```

The rule intentionally expects an explicit `.send()`. If a specific logger relies on `autoSend: true`, disable or scope the rule for that code.

## Supabase Realtime WebSocket streaming

Pass a Supabase project URL and publishable/anon key. The transport joins `realtime:next-loggers` by default and broadcasts `log` events.

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';

const log = createBrowserLogger({
  appName: 'storefront',
  maxLevel: 'info',
  supabase: {
    url: 'https://your-project.supabase.co',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    channel: 'application-logs',
    event: 'log',
  },
});

await log.info('cart updated', { itemCount: 3 }).send();
```

Use only a publishable/anon key in browser code—never a Supabase service-role key. Realtime Broadcast delivers events; it does not insert rows by itself. If logs must be stored, run a trusted subscriber that validates each event and inserts it into the desired table.

Node versions without a global `WebSocket` can supply a factory from their preferred WebSocket library:

```ts
const log = createNodeLogger({
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    webSocketFactory: (url) => new MyWebSocket(url),
  },
});
```

## HTTP transport

```ts
const log = createEdgeLogger({
  appName: 'edge-auth',
  http: {
    endpoint: 'https://logs.example.com/v1/events',
    headers: { authorization: `Bearer ${token}` },
  },
});
```

Custom transports implement one small interface:

```ts
import type { LogTransport } from '@oresoftware/next-loggers/base';

const transport: LogTransport = {
  name: 'my-transport',
  async write(record) {
    // Deliver the JSON-safe record.
  },
};
```

## Next.js

Client component:

```tsx
'use client';

import { createBrowserLogger } from '@oresoftware/next-loggers/browser';

const log = createBrowserLogger({ appName: 'web' });
```

Node route handler or server component:

```ts
import { createNodeLogger } from '@oresoftware/next-loggers/node';
```

Edge middleware/route code can pass an execution context so remote delivery is attached to the request lifetime:

```ts
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';

const log = createEdgeLogger({
  appName: 'middleware',
  executionContext: event,
  request,
});

void log.warn('request blocked').send();
```

For Next.js `after()`, pass it without making this package depend on Next:

```ts
import { after } from 'next/server';
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const log = createNodeLogger({ appName: 'web', after });
```

Every transport promise is also tracked in the exported `pendingLogPromises` registry, analogous to a focused `dd-proms.ts`. `waitForPendingLogs()` drains writes across logger instances.

## Shutdown delivery

Runtime loggers install coordinated lifecycle drains by default:

- Browser loggers flush on `pagehide`, `beforeunload`, and `unload`. HTTP writes use `keepalive`, and active records are retried through `navigator.sendBeacon()` when available.
- Node and Next.js loggers flush all registered instances on one-shot `beforeExit`, `SIGINT`, and `SIGTERM`, then re-raise the signal so normal exit semantics are preserved.
- Bun uses the equivalent process lifecycle only when actually running under Bun.
- Deno performs a best-effort drain on its `unload` event.
- Edge loggers attach each send to the provided `executionContext.waitUntil()`.

Shutdown also sends any chain event that was created but never explicitly sent. The ESLint rule catches that mistake earlier, while the runtime behavior is the safety net.

```ts
await log.flushOnExit({ timeoutMillis: 4_000 });
await log.close({ timeoutMillis: 4_000 });
```

Set `flushOnShutdown: false` for Node/Bun or `flushOnUnload: false` for browser/Deno when the host owns lifecycle coordination. A direct `process.exit()` cannot wait for asynchronous JavaScript; call `await log.close()` before using it. Browser shutdown APIs are inherently best-effort, so use the HTTP transport in addition to WebSocket streaming when the final records must be persisted.

## Extending the classes

All logger and event classes are public. Protected event state and logger hooks allow custom event builders, console formatting, dispatch, and runtime fields without forking the package:

```ts
import {
  BaseLogger,
  LogEvent,
  type LogArgument,
  type LogLevel,
} from '@oresoftware/next-loggers/base';

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

await new AuditLogger().info('changed role').withActor('user-1').send();
```

## Behavior

- Levels are ordered as `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.
- Calls return a `LogEvent`; call `.send()` after adding context.
- Set `autoSend: true` to enqueue `.send()` in a microtask.
- Console output is enabled by default; set `console: false` to disable it.
- `.send(false)` writes to the console but skips remote transports.
- `.flush()` waits for pending transport writes; pass `sendUnsent: true` to recover unfinished chains.
- `.flushOnExit()` sends unfinished chains and runs transport shutdown hooks.
- `.close()` performs the shutdown flush and then closes transports.
