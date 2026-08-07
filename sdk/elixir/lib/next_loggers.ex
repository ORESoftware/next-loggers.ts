defmodule ORESoftware.NextLoggers do
  @moduledoc """
  Dependency-free Elixir implementation of the `next-loggers/v1` contract.

  Context is scoped to the current BEAM process and restored after the callback.
  OpenTelemetry and Supabase are injected transports; this module never installs
  global providers, telemetry handlers, or automatic instrumentation.
  """

  @schema "next-loggers/v1"
  @context_key {__MODULE__, :context}

  def schema, do: @schema

  def new(app_name, opts \\ []) when is_binary(app_name) and is_list(opts) do
    if String.trim(app_name) == "", do: raise(ArgumentError, "app_name must not be empty")

    %{
      app_name: app_name,
      name: Keyword.get(opts, :name),
      runtime: Keyword.get(opts, :runtime, "elixir"),
      fields: Map.new(Keyword.get(opts, :fields, %{})),
      transports: List.wrap(Keyword.get(opts, :transports, [])),
      # Default routing for OTEL transports when a call makes no choice.
      otel: Keyword.get(opts, :otel, true),
      id_factory: Keyword.get(opts, :id_factory, &default_id/0),
      clock: Keyword.get(opts, :clock, &default_clock/0)
    }
  end

  def current_context do
    Process.get(@context_key, %{})
  end

  def with_context(context, callback) when is_map(context) and is_function(callback, 0) do
    previous = Process.get(@context_key, :__missing__)
    Process.put(@context_key, context)

    try do
      callback.()
    after
      case previous do
        :__missing__ -> Process.delete(@context_key)
        value -> Process.put(@context_key, value)
      end
    end
  end

  @doc "Derived logger that delivers every record to OTEL transports (the default)."
  def use_otel(logger) when is_map(logger), do: with_otel(logger, true)

  @doc """
  Derived logger that keeps records off OTEL transports; every other transport
  still receives them: `logger |> ORESoftware.NextLoggers.not_otel() |> info("msg")`.
  """
  def not_otel(logger) when is_map(logger), do: with_otel(logger, false)

  def with_otel(logger, enabled) when is_map(logger) and is_boolean(enabled),
    do: Map.put(logger, :otel, enabled)

  def otel_enabled(logger) when is_map(logger), do: Map.get(logger, :otel, true)

  def info(logger, message, fields \\ %{}), do: log(logger, "INFO", message, fields)
  def warn(logger, message, fields \\ %{}), do: log(logger, "WARN", message, fields)
  def error(logger, message, fields \\ %{}), do: log(logger, "ERROR", message, fields)

  def log(logger, level, message, event_fields)
      when is_map(logger) and is_binary(level) and is_binary(message) and is_map(event_fields) do
    log(logger, level, message, event_fields, otel_enabled(logger))
  end

  @doc """
  `otel` overrides this call's routing: `true` forces delivery to OTEL
  transports, `false` skips them.
  """
  def log(logger, level, message, event_fields, otel)
      when is_map(logger) and is_binary(level) and is_binary(message) and is_map(event_fields) and
             is_boolean(otel) do
    context = current_context()

    fields =
      logger.fields
      |> Map.merge(Map.get(context, :fields, %{}))
      |> put_optional("otel.span_id", Map.get(context, :span_id))
      |> Map.put("otel.trace_flags", Map.get(context, :trace_flags, 0))
      |> put_optional("otel.trace_state", Map.get(context, :trace_state))
      |> Map.merge(event_fields)

    trace_id = Map.get(context, :trace_id)

    record =
      %{
        "schema" => @schema,
        "id" => logger.id_factory.(),
        "timestamp" => logger.clock.(),
        "level" => level,
        "runtime" => logger.runtime,
        "appName" => logger.app_name,
        "message" => message,
        "values" => [message],
        "fields" => fields
      }
      |> put_optional("name", logger.name)
      |> put_optional("traceId", trace_id)
      |> maybe_put_trace_ids(trace_id)
      |> maybe_put_tags(Map.get(context, :tags, []))

    Enum.each(logger.transports, &deliver(&1, record, otel))

    record
  end

  # otel_transport/1 returns a tagged transport so routing can skip it without
  # inspecting the closure.
  defp deliver({:otel, _sink}, _record, false), do: :ok
  defp deliver({:otel, sink}, record, _otel) when is_function(sink, 1), do: call(sink, record)
  defp deliver(sink, record, _otel) when is_function(sink, 1), do: call(sink, record)

  defp call(sink, record) do
    case sink.(record) do
      :ok -> :ok
      other -> raise "transport returned #{inspect(other)}"
    end
  end

  def otel_transport(sink) when is_function(sink, 1) do
    {:otel,
     fn record ->
       attributes =
         %{
           "service.name" => record["appName"],
           "next_logger.schema" => record["schema"],
           "next_logger.runtime" => record["runtime"],
           "log.record.uid" => record["id"]
         }
         |> put_optional("trace.id", record["traceId"])
         |> Map.merge(
           Map.new(record["fields"], fn {key, value} ->
             {"next_logger.field.#{key}", value}
           end)
         )

       sink.(%{
         "body" => record["message"],
         "severityText" => record["level"],
         "severityNumber" => severity_number(record["level"]),
         "timestamp" => record["timestamp"],
         "attributes" => attributes
       })

       :ok
     end}
  end

  def supabase_transport(sender) when is_function(sender, 1) do
    fn record ->
      sender.(record)
      :ok
    end
  end

  defp maybe_put_trace_ids(map, nil), do: map
  defp maybe_put_trace_ids(map, ""), do: map
  defp maybe_put_trace_ids(map, trace_id), do: Map.put(map, "traceIds", [trace_id])

  defp maybe_put_tags(map, []), do: map
  defp maybe_put_tags(map, tags), do: Map.put(map, "tags", Enum.uniq(tags))

  defp put_optional(map, _key, nil), do: map
  defp put_optional(map, _key, ""), do: map
  defp put_optional(map, key, value), do: Map.put(map, key, value)

  defp severity_number("TRACE"), do: 1
  defp severity_number("DEBUG"), do: 5
  defp severity_number("INFO"), do: 9
  defp severity_number("WARN"), do: 13
  defp severity_number("ERROR"), do: 17
  defp severity_number("FATAL"), do: 21

  defp default_id do
    "elixir-#{System.unique_integer([:monotonic, :positive])}"
  end

  defp default_clock do
    DateTime.utc_now() |> DateTime.to_iso8601()
  end
end
