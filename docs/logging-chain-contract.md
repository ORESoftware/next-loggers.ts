# Static observability logging-chain contract

JavaScript and TypeScript call sites that use `@oresoftware/next-loggers` should carry a stable code-location trace marker, a stable routine marker, and terminate the event with `send()`.

```ts
function handleRequest() {
  const routineId = 'ores-routine-V1StGXR8_Z5jdHi6B-myT';

  log.info('request accepted')
    .addTraceId('ores-trace-cW7Kq3_nR9fX2mP8AzL4H')
    .addRoutineId(routineId)
    .send();
}
```

The `ores-trace-*` value is a static call-site marker. Keep it as a hardcoded literal in `addTrace()` or `addTraceId()`; do not hoist it into a variable. This is distinct from a dynamic OpenTelemetry request trace propagated through runtime context.

The routine marker may be declared once at the top of a function or method as `routineId` and reused by log statements in that routine. Inline `ores-routine-*` literals are also accepted.

The ESLint plugin exports `next-loggers/require-observability-chain`. The recommended flat configuration enables it as a warning. The rule checks logger instances imported or created through next-loggers and reports one actionable finding when a statement is missing an inline `ores-trace-*`, a routine marker, or terminal `.send()`.

For a deliberate one-statement exception, use native ESLint suppression immediately above the statement and include a reason:

```ts
// eslint-disable-next-line next-loggers/require-observability-chain -- third-party bridge owns delivery
logger.info('bridged externally');
```

Do not disable the rule for a whole file or repository to accommodate a single adapter. Fleet repository audits performed by `ores-cli` also recognize `// ores-lint-disable-next-line logging-chain-contract -- reason` for the equivalent one-statement exception.
