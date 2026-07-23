import { AsyncLocalStorage } from 'node:async_hooks';

import {
  setLogContextProvider,
  type LogContext,
  type LogContextProvider,
  type LogUser,
} from './base-logger.js';

export type { LogContext, LogContextProvider };

/**
 * Structural view of the underlying AsyncLocalStorage: keeps the emitted
 * declaration file free of node:async_hooks so consumers without @types/node
 * (and with skipLibCheck: false) still typecheck.
 */
export interface LogContextStorage {
  getStore(): LogContext | undefined;
  run<R>(store: LogContext, callback: () => R): R;
}

/**
 * AsyncLocalStorage-backed ambient log context for Node.js, Bun, Deno, and
 * edge runtimes with node:async_hooks support (Vercel edge-light, workerd
 * with nodejs_compat). Browsers resolve this specifier to context-browser.js
 * through the package's conditional exports.
 */
export const logContextStorage: LogContextStorage = new AsyncLocalStorage<LogContext>();

/** Runs callback with the given context active; nested calls shadow outer frames. */
export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContextStorage.run({ ...context }, callback);
}

export function getLogContext(): LogContext | undefined {
  return logContextStorage.getStore();
}

/**
 * Shallow-merges a patch into the live context frame (objects merge, arrays
 * append and dedupe). Returns false when no frame is active.
 */
export function updateLogContext(patch: LogContext): boolean {
  const current = logContextStorage.getStore();
  if (!current) {
    return false;
  }
  if (patch.loggedInUser) {
    current.loggedInUser = { ...current.loggedInUser, ...patch.loggedInUser };
  }
  if (patch.users && patch.users.length > 0) {
    current.users = [...(current.users ?? []), ...patch.users];
  }
  if (patch.fields) {
    current.fields = { ...current.fields, ...patch.fields };
  }
  const existingTraces = current.traceIds ?? (current.traceId ? [current.traceId] : []);
  if (patch.traceId) {
    current.traceId = patch.traceId;
    current.traceIds = Array.from(new Set([...existingTraces, patch.traceId]));
  }
  if (patch.traceIds && patch.traceIds.length > 0) {
    current.traceIds = Array.from(
      new Set([...(current.traceIds ?? existingTraces), ...patch.traceIds]),
    );
  }
  if (patch.routineId) {
    current.routineId = patch.routineId;
  }
  if (patch.tags && patch.tags.length > 0) {
    current.tags = Array.from(new Set([...(current.tags ?? []), ...patch.tags]));
  }
  return true;
}

/** Convenience for the most common patch: recording who is acting. */
export function setContextLoggedInUser(user: LogUser): boolean {
  return updateLogContext({ loggedInUser: user });
}

/** A provider reading this module's storage, suitable for setLogContextProvider or logger options. */
export const logContextProvider: LogContextProvider = () => logContextStorage.getStore();

/**
 * Makes every logger in the process read this module's storage.
 * Returns an uninstall function that restores the previous provider.
 */
export function installLogContextProvider(): () => void {
  const previous = setLogContextProvider(logContextProvider);
  return () => {
    setLogContextProvider(previous);
  };
}
