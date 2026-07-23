import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLogger,
  SupabaseRealtimeTransport,
} from '@oresoftware/next-loggers/base';

class MockWebSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(sink) {
    this.sink = sink;
  }

  send(data) {
    const message = JSON.parse(data);
    this.sink.push(message);
    if (message.event === 'phx_join') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            topic: message.topic,
            event: 'phx_reply',
            payload: { status: 'ok', response: {} },
            ref: message.ref,
          }),
        });
      });
    }
  }

  serverSend(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.({});
  }
}

const makeTransport = (sink, sockets, extra = {}) =>
  new SupabaseRealtimeTransport({
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    reconnect: false,
    webSocketFactory() {
      const socket = new MockWebSocket(sink);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    ...extra,
  });

test('supabase url normalization: ws passthrough and existing /websocket path kept', async () => {
  for (const [input, expected] of [
    ['wss://custom.example.test/realtime/v1/websocket', /^wss:\/\/custom\.example\.test\/realtime\/v1\/websocket/],
    ['http://plain.example.test', /^ws:\/\/plain\.example\.test\/realtime\/v1\/websocket/],
  ]) {
    let seenUrl = '';
    const transport = new SupabaseRealtimeTransport({
      url: input,
      anonKey: 'k',
      reconnect: false,
      webSocketFactory(url) {
        seenUrl = url;
        const socket = new MockWebSocket([]);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const logger = createLogger({ console: false, transports: transport });
    await logger.warn('probe').send();
    assert.match(seenUrl, expected);
    await logger.close();
  }
  await assert.rejects(
    new SupabaseRealtimeTransport({ url: 'ftp://x.test', anonKey: 'k', reconnect: false }).write({
      schema: 'next-loggers/v1',
      id: 'x',
      timestamp: 'now',
      level: 'ERROR',
      runtime: 'base',
      appName: 'app',
      message: 'invalid url probe',
      values: [],
      fields: {},
    }),
    /http\(s\) or ws\(s\)/,
  );
});

test('supabase queue drops the oldest message beyond maxQueueSize', async () => {
  const sink = [];
  const sockets = [];
  let failing = true;
  const transport = new SupabaseRealtimeTransport({
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    reconnect: false,
    maxQueueSize: 2,
    webSocketFactory() {
      if (failing) {
        throw new Error('offline');
      }
      const socket = new MockWebSocket(sink);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const logger = createLogger({
    console: false,
    transports: transport,
    onTransportError: () => undefined,
  });

  await logger.error('first').send();
  await logger.error('second').send();
  await logger.error('third').send();

  failing = false;
  await transport.flush();
  const delivered = sink
    .filter((message) => message.event === 'broadcast')
    .map((message) => message.payload.payload.message);
  assert.deepEqual(delivered, ['second', 'third']);
  await logger.close();
});

test('supabase heartbeat pings after joining', async () => {
  const sink = [];
  const sockets = [];
  const transport = makeTransport(sink, sockets, { heartbeatMillis: 15 });
  const logger = createLogger({ console: false, transports: transport });
  await logger.warn('join now').send();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const heartbeats = sink.filter((message) => message.event === 'heartbeat');
  assert.equal(heartbeats.length >= 1, true, 'expected at least one heartbeat');
  assert.equal(heartbeats[0].topic, 'phoenix');
  await logger.close();
});

test('supabase reconnects with a fresh socket after phx_error closes the channel', async () => {
  const sink = [];
  const sockets = [];
  const transport = makeTransport(sink, sockets);
  const logger = createLogger({
    console: false,
    transports: transport,
    onTransportError: () => undefined,
  });

  await logger.warn('before failure').send();
  assert.equal(sockets.length, 1);
  sockets[0].serverSend({ topic: 'realtime:next-loggers', event: 'phx_error', payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await logger.warn('after reconnect').send();
  assert.equal(sockets.length, 2, 'a second socket should be created');
  const delivered = sink
    .filter((message) => message.event === 'broadcast')
    .map((message) => message.payload.payload.message);
  assert.deepEqual(delivered, ['before failure', 'after reconnect']);
  await logger.close();
});

test('supabase transport refuses writes after close', async () => {
  const sink = [];
  const sockets = [];
  const transport = makeTransport(sink, sockets);
  const logger = createLogger({ console: false, transports: transport });
  await logger.warn('delivered').send();
  await logger.close();

  const failures = [];
  const second = createLogger({
    console: false,
    transports: transport,
    onTransportError: (error) => void failures.push(error),
  });
  await second.warn('too late').send();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /closed/);
});

test('waitUntil and after lifecycle hooks that throw are routed to onLifecycleError', async () => {
  const lifecycleErrors = [];
  const logger = createLogger({
    console: false,
    transports: { write: async () => undefined },
    waitUntil: () => {
      throw new Error('waitUntil rejected');
    },
    after: () => {
      throw new Error('after rejected');
    },
    onLifecycleError: (error, hook) => void lifecycleErrors.push(hook),
  });
  await logger.info('lifecycle probe').send();
  assert.deepEqual(lifecycleErrors.sort(), ['after', 'waitUntil']);
});
