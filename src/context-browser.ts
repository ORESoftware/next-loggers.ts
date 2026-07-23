import {
  setLogContextProvider,
  type LogContext,
  type LogContextProvider,
  type LogUser,
} from './base-logger.js';

export type { LogContext, LogContextProvider };

/**
 * Browser fallback for `@oresoftware/next-loggers/context`: browsers have no
 * AsyncLocalStorage, so this keeps one module-scoped frame. runWithLogContext
 * restores the previous frame when its callback (or the promise it returns)
 * settles, which is reliable for a single user session but cannot isolate
 * overlapping async flows. Apps needing true zone tracking (e.g. Angular
 * zones) can attach their own store via logger.setALS or setLogContextProvider.
 */
let currentContext: LogContext | undefined;

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  const previous = currentContext;
  currentContext = { ...context };
  let result: T;
  try {
    result = callback();
  } catch (error) {
    currentContext = previous;
    throw error;
  }
  if (isThenable(result)) {
    return (result as Promise<unknown>).finally(() => {
      currentContext = previous;
    }) as T;
  }
  currentContext = previous;
  return result;
}

export function getLogContext(): LogContext | undefined {
  return currentContext;
}

export function updateLogContext(patch: LogContext): boolean {
  const current = currentContext;
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

export function setContextLoggedInUser(user: LogUser): boolean {
  return updateLogContext({ loggedInUser: user });
}

export const logContextProvider: LogContextProvider = () => currentContext;

export function installLogContextProvider(): () => void {
  const previous = setLogContextProvider(logContextProvider);
  return () => {
    setLogContextProvider(previous);
  };
}
