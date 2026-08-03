# Next Loggers observability reference stack

This directory is a pinned, local integration stack for the explicit
`next-loggers` OpenTelemetry adapters:

```text
application-owned logger APIs
        │
        ├── OTLP traces ───────┐
        ├── OTLP logs ─────────┼── OpenTelemetry Collector
        └── OTLP metrics ──────┘        │
                                        ├── traces → Tempo
                                        ├── logs   → Loki
                                        └── metrics→ Prometheus
                                                      │
                                                      └── Grafana
```

The Collector receives only telemetry that applications send explicitly. The
repository does not install automatic instrumentation, register global OTEL
providers, hook module loading, or patch console, `fetch`, HTTP clients,
database drivers, prototypes, or framework internals.

Browser, Flutter, desktop, and other distributed clients should send durable
logs through the authenticated Supabase ingestion transport. Direct browser OTLP
is intentionally not enabled with CORS. Supabase Realtime can remain an optional
second transport for live tailing.

## Pinned components

- OpenTelemetry Collector Contrib `0.157.0`
- Loki `3.7.2`
- Prometheus `3.13.1` LTS
- Tempo `2.10.5`
- Grafana `13.1.0`

The GitHub workflow pulls and starts these exact tags, validates the Collector,
Loki, Prometheus, and Compose configurations, then sends a correlated OTLP log
and trace through the running stack.

## Start locally

```sh
cd observability
cp .env.example .env
# Replace both placeholder secret values in .env.
docker compose --env-file .env config --quiet
docker compose --env-file .env pull
docker compose --env-file .env up -d
node ../scripts/smoke-observability.mjs
```

Local endpoints bind to loopback only:

| Endpoint | Address |
|---|---|
| Grafana | `http://127.0.0.1:3000` |
| Prometheus | `http://127.0.0.1:9090` |
| Loki readiness/API | `http://127.0.0.1:3100` |
| Tempo readiness/API | `http://127.0.0.1:3200` |
| OTLP gRPC | `127.0.0.1:4317` |
| OTLP HTTP | `http://127.0.0.1:4318` |
| Collector health | `http://127.0.0.1:13133` |

Stop and delete local data with:

```sh
docker compose --env-file .env down -v --remove-orphans
```

## Signal handling

### Logs and Loki cardinality

The Collector uses Loki's native OTLP endpoint at `/otlp`. Loki stores only
`service.name`, `service.namespace`, and `deployment.environment.name` as index
labels. Trace IDs, span IDs, service-instance IDs, pod names, user IDs, request
IDs, and arbitrary logger fields remain structured metadata rather than stream
labels.

Grafana's Loki data source links the structured-metadata `trace_id` label to the
Tempo data source. Tempo links traces back to Loki using the normalized OTLP
resource labels (`service_name`, `service_namespace`, and
`deployment_environment_name`).

### Traces and generated metrics

Tempo stores traces on a local filesystem volume and generates span metrics and
service graphs. It remote-writes those metrics, including exemplars, to
Prometheus. Prometheus's remote-write receiver is reachable only on the private
Compose network; its host UI/API port is bound to loopback.

### Metrics and alerts

Prometheus scrapes:

- its own metrics;
- Collector internal telemetry on port `8888`;
- application OTLP metrics exposed by the Collector on port `9464`;
- Loki and Tempo service metrics.

The included alerts cover target availability, Prometheus reload failures,
logger transport failures, bounded-queue drops, and sustained pending-write
backlogs. The provisioned Grafana dashboard visualizes the same logger health
signals and recent error/fatal logs.

## Security and failure boundaries

This stack is deliberately constrained for local and CI use:

- every host port binds to `127.0.0.1`;
- the Compose network is internal;
- containers use read-only root filesystems where practical;
- Linux capabilities are dropped and `no-new-privileges` is enabled;
- Grafana requires non-default admin and secret-key values;
- analytics, update checks, sign-up, and organization creation are disabled;
- Collector receive sizes, memory, batches, queues, retries, and timeouts are
  bounded;
- sensitive header, connection-string, and user identity attributes are removed
  again at the Collector as defense in depth;
- Loki line size, retention, ingestion rate, burst size, query parallelism, and
  query result size are bounded;
- telemetry export failure cannot alter application business behavior.

Redaction must still happen before export. A Collector cannot reliably remove a
secret embedded inside an arbitrary log body, exception message, SQL statement,
or URL. Do not log bearer tokens, cookies, credentials, payment data, raw request
or response bodies, or unrestricted user objects.

## Production deployment requirements

Do not expose this single-node Compose topology directly to a public network.
A production deployment should additionally provide:

1. TLS or mTLS and authenticated OTLP ingress behind a private load balancer or
   service mesh.
2. Tenant isolation and authentication for Loki, Tempo, Prometheus-compatible
   storage, and Grafana.
3. Object storage, replication, backups, capacity planning, and tested restore
   procedures for Loki and Tempo.
4. Highly available Collector gateways with persistent sending queues and a
   dead-letter/replay policy appropriate to the data classification.
5. Kubernetes NetworkPolicies, Pod Security Standards, read-only service account
   tokens, secret-manager integration, and explicit egress controls.
6. Alertmanager routing, runbooks, SLOs, retention/legal review, and cost/cardinality
   budgets.
7. Version pinning by digest through the organization's image promotion process,
   plus vulnerability scanning and scheduled upgrades.

The same signal topology can be translated to Helm, Jsonnet, Terraform, or the
existing `k8s-cluster` repository after the local contract is stable.
