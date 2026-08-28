# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/oresoftware/next_loggers"

class NextLoggersTest < Minitest::Test
  def test_context_flows_to_otel_and_supabase_and_is_restored
    otel = []
    supabase = []
    logger = ORESoftware::NextLoggers::Logger.new(
      app_name: "payments",
      name: "audit",
      fields: { environment: "test" },
      id_factory: -> { "ruby-record-1" },
      clock: -> { "2026-01-02T03:04:05.000Z" },
      transports: [
        ORESoftware::NextLoggers::OtelTransport.new { |record| otel << record },
        ORESoftware::NextLoggers::SupabaseTransport.new { |record| supabase << record }
      ]
    )

    record = ORESoftware::NextLoggers.with_context(
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
      trace_state: "vendor=value",
      fields: { requestId: "request-1" },
      tags: %w[otel ruby]
    ) do
      logger.error("payment failed", orderId: "order-42")
    end

    assert_equal "next-loggers/v1", record.fetch("schema")
    assert_equal "ERROR", record.fetch("level")
    assert_equal "0123456789abcdef0123456789abcdef", record.fetch("traceId")
    assert_equal "0123456789abcdef", record.fetch("fields").fetch("otel.span_id")
    assert_equal "request-1", record.fetch("fields").fetch("requestId")
    assert_equal "order-42", record.fetch("fields").fetch("orderId")
    assert_equal 17, otel.fetch(0).fetch("severityNumber")
    assert_same record, supabase.fetch(0)
    assert_nil ORESoftware::NextLoggers.current_context
  end

  def test_thread_local_context_is_isolated
    logger = ORESoftware::NextLoggers::Logger.new(app_name: "app", transports: [])
    traces = Queue.new

    threads = { a: "trace-a", b: "trace-b" }.map do |name, trace_id|
      Thread.new do
        value = ORESoftware::NextLoggers.with_context(trace_id: trace_id, span_id: "#{name}-span") do
          logger.info(name.to_s).fetch("traceId")
        end
        traces << value
      end
    end
    threads.each(&:join)

    assert_equal %w[trace-a trace-b], [traces.pop, traces.pop].sort
  end

  def test_per_event_otel_routing_preserves_regular_transports
    otel = []
    regular = []
    logger = ORESoftware::NextLoggers::Logger.new(
      app_name: "routing",
      otel: false,
      transports: [
        ORESoftware::NextLoggers::OtelTransport.new { |record| otel << record },
        ->(record) { regular << record }
      ]
    )

    default_off = logger.event(:info, "default-off")
    refute default_off.otel_enabled?(logger.otel_enabled?)
    default_off.send
    logger.event(:info, "forced-on").use_otel.send
    logger.event(:info, "reset-off").use_otel.reset_otel.send
    logger.use_otel
    logger.event(:warn, "forced-off").not_otel.send
    logger.event(:info, "logger-on").with_otel(true).send

    assert_equal %w[forced-on logger-on], otel.map { |record| record.fetch("body") }
    assert_equal(
      %w[default-off forced-on reset-off forced-off logger-on],
      regular.map { |record| record.fetch("message") }
    )
  end
end
