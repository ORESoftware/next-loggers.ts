defmodule NextLoggersTest do
  use ExUnit.Case, async: true

  test "process-local context flows into records" do
    logger =
      NextLoggers.new(
        app_name: "payments",
        transport: NextLoggers.memory_transport()
      )

    NextLoggers.with_context(
      %{
        trace_id: "trace-1",
        span_id: "span-1",
        trace_flags: 1,
        fields: %{route: "/pay"}
      },
      fn ->
        assert {:ok, _} =
                 logger
                 |> NextLoggers.info(["inside"])
                 |> NextLoggers.send()
      end
    )

    assert_receive {:next_loggers_record, record}
    assert record.traceId == "trace-1"
    assert record.fields["otel.span_id"] == "span-1"
    assert record.fields["route"] == "/pay"
    assert NextLoggers.current_context() == nil
  end

  test "BEAM processes keep independent context" do
    parent = self()

    for trace <- ["left", "right"] do
      spawn(fn ->
        NextLoggers.with_context(%{trace_id: trace}, fn ->
          send(parent, {:trace, trace, NextLoggers.current_context().trace_id})
        end)
      end)
    end

    assert_receive {:trace, "left", "left"}
    assert_receive {:trace, "right", "right"}
  end

  test "explicit span lifecycle stays behind next-loggers" do
    parent = self()

    logger =
      NextLoggers.new(
        minimum_level: :debug,
        transport: NextLoggers.memory_transport()
      )

    tracer = %{
      start: fn _name, _attributes ->
        {:span, %{trace_id: "trace", span_id: "span", trace_flags: 1}}
      end,
      set_status: fn _span, code, _description -> send(parent, {:status, code}) end,
      record_exception: fn _span, _kind, reason, _stack ->
        send(parent, {:recorded, reason})
      end,
      end: fn _span -> send(parent, :ended) end
    }

    assert 7 ==
             NextLoggers.with_span(
               logger,
               tracer,
               "operation",
               %{},
               fn _span -> 7 end
             )

    assert_receive {:status, 1}
    assert_receive :ended
    assert_receive {:next_loggers_record, %{message: "span started: operation"}}
    assert_receive {:next_loggers_record, %{message: "span completed: operation"}}
  end

  test "OTEL lifecycle and start failures do not replace results" do
    logger =
      NextLoggers.new(
        minimum_level: :debug,
        transport: NextLoggers.memory_transport()
      )

    broken = %{
      start: fn _name, _attributes -> {:span, %{trace_id: "trace"}} end,
      set_status: fn _span, _code, _description -> raise "status unavailable" end,
      record_exception: fn _span, _kind, _reason, _stack ->
        raise "record unavailable"
      end,
      end: fn _span -> raise "end unavailable" end
    }

    assert 11 ==
             NextLoggers.with_span(
               logger,
               broken,
               "resilient",
               %{},
               fn _ -> 11 end
             )

    failing = %{
      broken
      | start: fn _name, _attributes -> raise "sdk unavailable" end
    }

    assert 12 ==
             NextLoggers.with_span(
               logger,
               failing,
               "fallback",
               %{},
               fn _ -> 12 end
             )

    assert bridge_failure?("set success status")
    assert bridge_failure?("end span")
    assert bridge_failure?("start span")
  end

  defp bridge_failure?(operation) do
    receive do
      {:next_loggers_record, record} ->
        if record.fields["otel.bridge_operation"] == operation do
          true
        else
          bridge_failure?(operation)
        end
    after
      1_000 -> false
    end
  end
end
