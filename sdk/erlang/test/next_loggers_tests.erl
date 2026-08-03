-module(next_loggers_tests).
-include_lib("eunit/include/eunit.hrl").

context_test() ->
    Logger = next_loggers:new(#{
        app_name => <<"payments">>,
        minimum_level => debug,
        transport => next_loggers:memory_transport()
    }),
    Context = #{
        trace_id => <<"trace-1">>,
        span_id => <<"span-1">>,
        trace_flags => 1,
        fields => #{route => <<"/pay">>}
    },
    next_loggers:with_context(Context, fun() ->
        {ok, _} = next_loggers:send(next_loggers:info(Logger, [<<"inside">>]))
    end),
    receive
        {next_loggers_record, Record} ->
            ?assertEqual(<<"trace-1">>, maps:get(traceId, Record)),
            Fields = maps:get(fields, Record),
            ?assertEqual(<<"span-1">>, maps:get(<<"otel.span_id">>, Fields)),
            ?assertEqual(<<"/pay">>, maps:get(<<"route">>, Fields))
    after 1000 -> ?assert(false)
    end,
    ?assertEqual(undefined, next_loggers:current_context()).

process_isolation_test() ->
    Parent = self(),
    Spawn = fun(Trace) -> spawn(fun() ->
        next_loggers:with_context(#{trace_id => Trace}, fun() ->
            Parent ! {trace, Trace, maps:get(trace_id, next_loggers:current_context())}
        end)
    end) end,
    _ = Spawn(<<"left">>),
    _ = Spawn(<<"right">>),
    receive {trace, <<"left">>, <<"left">>} -> ok after 1000 -> ?assert(false) end,
    receive {trace, <<"right">>, <<"right">>} -> ok after 1000 -> ?assert(false) end.

with_span_test() ->
    Parent = self(),
    Logger = next_loggers:new(#{
        minimum_level => debug,
        transport => next_loggers:memory_transport()
    }),
    Tracer = #{
        start => fun(_Name, _Attributes) ->
            {span, #{trace_id => <<"trace">>, span_id => <<"span">>, trace_flags => 1}}
        end,
        set_status => fun(_Span, Code, _Description) -> Parent ! {status, Code}, ok end,
        record_exception => fun(_Span, _Class, Reason, _Stack) ->
            Parent ! {recorded, Reason}, ok
        end,
        'end' => fun(_Span) -> Parent ! ended, ok end
    },
    ?assertEqual(
        7,
        next_loggers:with_span(Logger, Tracer, <<"op">>, #{}, fun(_Span) -> 7 end)
    ),
    receive {status, 1} -> ok after 1000 -> ?assert(false) end,
    receive ended -> ok after 1000 -> ?assert(false) end.

otel_failure_isolation_test() ->
    Logger = next_loggers:new(#{
        minimum_level => debug,
        transport => next_loggers:memory_transport()
    }),
    BrokenTracer = #{
        start => fun(_Name, _Attributes) -> {span, #{trace_id => <<"trace">>}} end,
        set_status => fun(_Span, _Code, _Description) -> erlang:error(status_unavailable) end,
        record_exception => fun(_Span, _Class, _Reason, _Stack) ->
            erlang:error(record_unavailable)
        end,
        'end' => fun(_Span) -> erlang:error(end_unavailable) end
    },
    ?assertEqual(
        11,
        next_loggers:with_span(
            Logger, BrokenTracer, <<"resilient">>, #{}, fun(_Span) -> 11 end)
    ),
    StartFailure = BrokenTracer#{
        start := fun(_Name, _Attributes) -> erlang:error(sdk_unavailable) end
    },
    ?assertEqual(
        12,
        next_loggers:with_span(
            Logger, StartFailure, <<"fallback">>, #{}, fun(_Span) -> 12 end)
    ),
    ?assert(receive_bridge_failure(<<"set success status">>)),
    ?assert(receive_bridge_failure(<<"end span">>)),
    ?assert(receive_bridge_failure(<<"start span">>)).

receive_bridge_failure(Operation) ->
    receive
        {next_loggers_record, Record} ->
            case maps:get(
                <<"otel.bridge_operation">>, maps:get(fields, Record, #{}), undefined
            ) of
                Operation -> true;
                _ -> receive_bridge_failure(Operation)
            end
    after 1000 -> false
    end.
