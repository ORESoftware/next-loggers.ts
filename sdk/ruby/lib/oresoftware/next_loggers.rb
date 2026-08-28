# frozen_string_literal: true

require "securerandom"
require "time"
require_relative "next_loggers/version"

module ORESoftware
  # Dependency-free Ruby implementation of the next-loggers/v1 wire contract.
  module NextLoggers
    SCHEMA = "next-loggers/v1"
    LEVELS = %w[TRACE DEBUG INFO WARN ERROR FATAL].freeze
    OTEL_SEVERITY_NUMBERS = {
      "TRACE" => 1,
      "DEBUG" => 5,
      "INFO" => 9,
      "WARN" => 13,
      "ERROR" => 17,
      "FATAL" => 21
    }.freeze
    CONTEXT_KEY = :__oresoftware_next_loggers_context

    Context = Struct.new(
      :trace_id,
      :span_id,
      :trace_flags,
      :trace_state,
      :fields,
      :tags,
      keyword_init: true
    ) do
      def initialize(**values)
        super
        self.trace_flags = trace_flags.nil? ? 1 : Integer(trace_flags)
        self.fields = (fields || {}).each_with_object({}) do |(key, value), out|
          out[key.to_s] = value
        end.freeze
        self.tags = Array(tags).map(&:to_s).uniq.freeze
        freeze
      end
    end

    module_function

    def current_context
      Thread.current.thread_variable_get(CONTEXT_KEY)
    end

    # Install context for the current thread and always restore the prior frame.
    def with_context(context)
      previous = current_context
      Thread.current.thread_variable_set(CONTEXT_KEY, normalize_context(context))
      yield
    ensure
      Thread.current.thread_variable_set(CONTEXT_KEY, previous)
    end

    def normalize_context(context)
      return nil if context.nil?
      return context if context.is_a?(Context)
      raise ArgumentError, "context must be a Hash, Context, or nil" unless context.is_a?(Hash)

      Context.new(
        trace_id: context[:trace_id] || context["trace_id"] || context[:traceId] || context["traceId"],
        span_id: context[:span_id] || context["span_id"] || context[:spanId] || context["spanId"],
        trace_flags: context[:trace_flags] || context["trace_flags"] || context[:traceFlags] || context["traceFlags"],
        trace_state: context[:trace_state] || context["trace_state"] || context[:traceState] || context["traceState"],
        fields: context[:fields] || context["fields"],
        tags: context[:tags] || context["tags"]
      )
    end

    # Application-owned OTEL sink. No global provider or runtime patching occurs.
    class OtelTransport
      def initialize(&sink)
        raise ArgumentError, "sink block is required" unless sink

        @sink = sink
      end

      def write(record)
        attributes = {
          "service.name" => record.fetch("appName"),
          "next_logger.schema" => record.fetch("schema"),
          "next_logger.runtime" => record.fetch("runtime"),
          "log.record.uid" => record.fetch("id")
        }
        attributes["trace.id"] = record["traceId"] if record.key?("traceId")
        record.fetch("fields").each do |key, value|
          attributes["next_logger.field.#{key}"] = value
        end

        @sink.call(
          {
            "body" => record.fetch("message"),
            "severityText" => record.fetch("level"),
            "severityNumber" => OTEL_SEVERITY_NUMBERS.fetch(record.fetch("level")),
            "timestamp" => record.fetch("timestamp"),
            "attributes" => attributes.freeze
          }.freeze
        )
      end

      def otel? = true
      def name = "opentelemetry"
    end

    # Client-safe Supabase transport; the application supplies its sender.
    class SupabaseTransport
      def initialize(&sender)
        raise ArgumentError, "sender block is required" unless sender

        @sender = sender
      end

      def write(record)
        @sender.call(record)
      end
    end

    class LogEvent
      attr_reader :logger, :level, :message, :fields

      def initialize(logger, level, message, fields = {})
        @logger = logger
        @level = level
        @message = message
        @fields = fields
        @otel_enabled = nil
      end

      def use_otel = with_otel(true)
      def not_otel = with_otel(false)

      def with_otel(enabled)
        @otel_enabled = !!enabled
        self
      end

      def reset_otel
        @otel_enabled = nil
        self
      end

      def otel_enabled?(fallback)
        @otel_enabled.nil? ? !!fallback : @otel_enabled
      end

      def send
        logger.emit_event(self)
      end
    end

    class Logger
      def initialize(
        app_name:,
        name: nil,
        runtime: "ruby",
        fields: {},
        transports: [],
        otel: true,
        id_factory: -> { SecureRandom.uuid },
        clock: -> { Time.now.utc.iso8601(3) }
      )
        raise ArgumentError, "app_name is required" if app_name.to_s.strip.empty?
        raise ArgumentError, "id_factory must respond to call" unless id_factory.respond_to?(:call)
        raise ArgumentError, "clock must respond to call" unless clock.respond_to?(:call)

        @app_name = app_name.to_s.freeze
        @name = name&.to_s
        @runtime = runtime.to_s.strip.empty? ? "ruby" : runtime.to_s
        @fields = stringify_keys(fields).freeze
        @transports = Array(transports).freeze
        @otel_enabled = !!otel
        @id_factory = id_factory
        @clock = clock
      end

      def log(level, message, fields = {})
        event(level, message, fields).send
      end

      def event(level, message, fields = {})
        LogEvent.new(self, level, message, fields)
      end

      def set_otel_enabled(enabled)
        @otel_enabled = !!enabled
        self
      end

      def use_otel = set_otel_enabled(true)
      def not_otel = set_otel_enabled(false)
      def otel_enabled? = @otel_enabled

      def emit_event(event)
        level_name = event.level.to_s.upcase
        raise ArgumentError, "unsupported level: #{event.level}" unless LEVELS.include?(level_name)

        context = NextLoggers.current_context
        merged_fields = @fields.merge(context&.fields || {})
        if context
          merged_fields["otel.span_id"] = context.span_id unless blank?(context.span_id)
          merged_fields["otel.trace_flags"] = context.trace_flags
          merged_fields["otel.trace_state"] = context.trace_state unless blank?(context.trace_state)
        end
        merged_fields.merge!(stringify_keys(event.fields))
        merged_fields.freeze

        text = event.message.to_s
        record = {
          "schema" => SCHEMA,
          "id" => @id_factory.call.to_s,
          "timestamp" => @clock.call.to_s,
          "level" => level_name,
          "runtime" => @runtime,
          "appName" => @app_name,
          "message" => text,
          "values" => [text].freeze,
          "fields" => merged_fields
        }
        record["name"] = @name unless blank?(@name)
        unless context.nil? || blank?(context.trace_id)
          record["traceId"] = context.trace_id.to_s
          record["traceIds"] = [context.trace_id.to_s].freeze
        end
        record["tags"] = context.tags unless context.nil? || context.tags.empty?
        record.freeze

        @transports.each do |transport|
          name = transport.respond_to?(:name) ? transport.name.to_s.downcase : ""
          is_otel = (transport.respond_to?(:otel?) && transport.otel?) || name == "opentelemetry"
          next if is_otel && !event.otel_enabled?(@otel_enabled)

          if transport.respond_to?(:write)
            transport.write(record)
          elsif transport.respond_to?(:call)
            transport.call(record)
          else
            raise ArgumentError, "transport must respond to write or call"
          end
        end
        record
      end

      LEVELS.each do |level|
        define_method(level.downcase) do |message, fields = {}|
          log(level, message, fields)
        end
      end

      private

      def stringify_keys(value)
        raise ArgumentError, "fields must be a Hash" unless value.is_a?(Hash)

        value.each_with_object({}) { |(key, item), out| out[key.to_s] = item }
      end

      def blank?(value)
        value.nil? || value.to_s.strip.empty?
      end
    end
  end
end
