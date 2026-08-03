-module(next_loggers_adversarial_tests).

-include_lib("eunit/include/eunit.hrl").

nested_context_restores_parent_test() ->
    ?assertEqual(#{}, next_loggers:current_context()),
    Parent = #{trace_id => <<"parent">>, span_id => <<"span-parent">>},
    Child = #{trace_id => <<"child">>, span_id => <<"span-child">>},
    next_loggers:with_context(Parent, fun() ->
        ?assertEqual(Parent, next_loggers:current_context()),
        next_loggers:with_context(Child, fun() ->
            ?assertEqual(Child, next_loggers:current_context())
        end),
        ?assertEqual(Parent, next_loggers:current_context())
    end),
    ?assertEqual(#{}, next_loggers:current_context()).

context_restores_after_throw_test() ->
    Token = make_ref(),
    ?assertEqual(Token, catch next_loggers:with_context(
        #{trace_id => <<"throw">>},
        fun() -> throw(Token) end
    )),
    ?assertEqual(#{}, next_loggers:current_context()).

context_restores_after_error_test() ->
    ?assertError(context_failure, next_loggers:with_context(
        #{trace_id => <<"error">>},
        fun() -> erlang:error(context_failure) end
    )),
    ?assertEqual(#{}, next_loggers:current_context()).

context_restores_after_exit_test() ->
    Token = {shutdown, make_ref()},
    ?assertExit(Token, next_loggers:with_context(
        #{trace_id => <<"exit">>},
        fun() -> exit(Token) end
    )),
    ?assertEqual(#{}, next_loggers:current_context()).

one_hundred_processes_never_cross_contaminate_test() ->
    Parent = self(),
    Count = 100,
    [spawn(fun() ->
        Suffix = iolist_to_binary(io_lib:format("~3..0B", [Index])),
        Trace = <<"trace-", Suffix/binary>>,
        Span = <<"span-", Suffix/binary>>,
        Message = <<"message-", Suffix/binary>>,
        Logger = next_loggers:new(<<"concurrency">>, <<"erlang">>, []),
        next_loggers:with_context(
            #{trace_id => Trace, span_id => Span, trace_flags => 1},
            fun() ->
                timer:sleep(Index rem 7),
                Record = next_loggers:info(Logger, Message, #{}),
                Fields = maps:get(fields, Record),
                Parent ! {context_result, Message, maps:get(traceId, Record),
                    maps:get(<<"otel.span_id">>, Fields)}
            end
        ),
        Parent ! {context_cleared, self(), next_loggers:current_context()}
    end) || Index <- lists:seq(0, Count - 1)],
    Results = collect_context_results(Count, #{}),
    Clears = collect_clears(Count, []),
    ?assertEqual(Count, map_size(Results)),
    maps:foreach(fun(Message, {Trace, Span}) ->
        Suffix = binary:part(Message, byte_size(<<"message-">>), byte_size(Message) - byte_size(<<"message-">>)),
        ?assertEqual(<<"trace-", Suffix/binary>>, Trace),
        ?assertEqual(<<"span-", Suffix/binary>>, Span)
    end, Results),
    ?assert(lists:all(fun({_Pid, Context}) -> Context =:= #{} end, Clears)),
    ?assertEqual(#{}, next_loggers:current_context()).

field_precedence_is_logger_context_event_test() ->
    Logger = next_loggers:new(
        <<"precedence">>,
        <<"erlang">>,
        #{source => logger, logger_only => true},
        []
    ),
    Record = next_loggers:with_context(
        #{fields => #{source => context, context_only => true}},
        fun() -> next_loggers:info(Logger, <<"inside">>, #{source => event, event_only => true}) end
    ),
    Fields = maps:get(fields, Record),
    ?assertEqual(event, maps:get(source, Fields)),
    ?assertEqual(true, maps:get(logger_only, Fields)),
    ?assertEqual(true, maps:get(context_only, Fields)),
    ?assertEqual(true, maps:get(event_only, Fields)).

records_without_context_omit_correlation_optionals_test() ->
    Logger = next_loggers:new(<<"plain">>, <<"erlang">>, []),
    Record = next_loggers:info(Logger, <<"plain">>, #{}),
    ?assertNot(maps:is_key(traceId, Record)),
    ?assertNot(maps:is_key(traceIds, Record)),
    ?assertNot(maps:is_key(tags, Record)),
    Fields = maps:get(fields, Record),
    ?assertNot(maps:is_key(<<"otel.span_id">>, Fields)),
    ?assertEqual(0, maps:get(<<"otel.trace_flags">>, Fields)).

empty_trace_id_is_omitted_test() ->
    Logger = next_loggers:new(<<"empty-trace">>, <<"erlang">>, []),
    Record = next_loggers:with_context(
        #{trace_id => <<>>, span_id => <<>>, tags => []},
        fun() -> next_loggers:info(Logger, <<"inside">>, #{}) end
    ),
    ?assertNot(maps:is_key(traceId, Record)),
    ?assertNot(maps:is_key(traceIds, Record)),
    ?assertNot(maps:is_key(tags, Record)).

all_otel_severity_mappings_are_stable_test() ->
    Parent = self(),
    Logger = next_loggers:new(
        <<"severity">>,
        <<"erlang">>,
        [next_loggers:otel_transport(fun(Value) -> Parent ! {otel_level, Value} end)]
    ),
    Expected = [
        {<<"TRACE">>, 1},
        {<<"DEBUG">>, 5},
        {<<"INFO">>, 9},
        {<<"WARN">>, 13},
        {<<"ERROR">>, 17},
        {<<"FATAL">>, 21}
    ],
    lists:foreach(fun({Level, _}) ->
        _ = next_loggers:log(Logger, Level, Level, #{})
    end, Expected),
    Actual = collect_otel_levels(length(Expected), []),
    ?assertEqual(Expected, [{maps:get(severityText, Value), maps:get(severityNumber, Value)}
        || Value <- Actual]).

otel_transport_copies_trace_and_structured_fields_test() ->
    Parent = self(),
    Logger = next_loggers:new(
        <<"otel">>,
        <<"erlang">>,
        [next_loggers:otel_transport(fun(Value) -> Parent ! {otel_record, Value} end)]
    ),
    _ = next_loggers:with_context(
        #{
            trace_id => <<"trace-otel">>,
            span_id => <<"span-otel">>,
            trace_flags => 1,
            fields => #{request_id => <<"request-1">>}
        },
        fun() -> next_loggers:error(Logger, <<"failed">>, #{order_id => <<"order-42">>}) end
    ),
    receive
        {otel_record, Value} ->
            ?assertEqual(<<"failed">>, maps:get(body, Value)),
            ?assertEqual(17, maps:get(severityNumber, Value)),
            Attributes = maps:get(attributes, Value),
            ?assertEqual(<<"trace-otel">>, maps:get(<<"trace.id">>, Attributes)),
            ?assertEqual(<<"span-otel">>, maps:get(<<"next_logger.field.otel.span_id">>, Attributes)),
            ?assertEqual(<<"order-42">>, maps:get(<<"next_logger.field.order_id">>, Attributes))
    after 1000 ->
        ?assert(false)
    end.

supabase_transport_receives_canonical_record_test() ->
    Parent = self(),
    Logger = next_loggers:new(
        <<"supabase">>,
        <<"erlang">>,
        [next_loggers:supabase_transport(fun(Value) -> Parent ! {supabase_record, Value} end)]
    ),
    Record = next_loggers:info(Logger, <<"client">>, #{safe => true}),
    receive
        {supabase_record, Captured} -> ?assertEqual(Record, Captured)
    after 1000 ->
        ?assert(false)
    end.

transports_run_in_configured_order_test() ->
    Parent = self(),
    Transport = fun(Index) -> fun(_Record) -> Parent ! {transport_order, Index}, ok end end,
    Logger = next_loggers:new(
        <<"order">>,
        <<"erlang">>,
        [Transport(1), Transport(2), Transport(3)]
    ),
    _ = next_loggers:info(Logger, <<"ordered">>, #{}),
    ?assertEqual([1, 2, 3], collect_transport_order(3, [])).

transport_failure_preserves_exception_identity_test() ->
    Token = make_ref(),
    Logger = next_loggers:new(
        <<"failure">>,
        <<"erlang">>,
        [fun(_Record) -> throw(Token) end]
    ),
    ?assertEqual(Token, catch next_loggers:error(Logger, <<"failed">>, #{})).

invalid_application_name_is_rejected_test() ->
    ?assertError(
        {invalid_app_name, <<>>},
        next_loggers:new(<<>>, <<"erlang">>, [])
    ).

generated_ids_are_unique_test() ->
    Logger = next_loggers:new(<<"ids">>, <<"erlang">>, []),
    Ids = [maps:get(id, next_loggers:info(Logger, <<"id">>, #{}))
        || _ <- lists:seq(1, 1000)],
    ?assertEqual(length(Ids), length(lists:usort(Ids))).

timestamp_has_rfc3339_shape_test() ->
    Logger = next_loggers:new(<<"time">>, <<"erlang">>, []),
    Timestamp = maps:get(timestamp, next_loggers:info(Logger, <<"time">>, #{})),
    ?assertMatch({match, _}, re:run(Timestamp, <<"^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$">>)).

custom_runtime_is_preserved_test() ->
    Logger = next_loggers:new(<<"runtime">>, <<"beam-native">>, []),
    Record = next_loggers:info(Logger, <<"runtime">>, #{}),
    ?assertEqual(<<"beam-native">>, maps:get(runtime, Record)).

context_tags_are_copied_test() ->
    Logger = next_loggers:new(<<"tags">>, <<"erlang">>, []),
    Tags = [<<"otel">>, <<"beam">>, <<"request">>],
    Record = next_loggers:with_context(
        #{trace_id => <<"trace">>, tags => Tags},
        fun() -> next_loggers:info(Logger, <<"tagged">>, #{}) end
    ),
    ?assertEqual(Tags, maps:get(tags, Record)).

wire_schema_and_values_are_stable_test() ->
    Logger = next_loggers:new(<<"wire">>, <<"erlang">>, []),
    Record = next_loggers:info(Logger, <<"hello">>, #{nested => #{safe => true}}),
    ?assertEqual(<<"next-loggers/v1">>, maps:get(schema, Record)),
    ?assertEqual([<<"hello">>], maps:get(values, Record)),
    ?assertEqual(#{safe => true}, maps:get(nested, maps:get(fields, Record))).

collect_context_results(0, Values) -> Values;
collect_context_results(Remaining, Values) ->
    receive
        {context_result, Message, Trace, Span} ->
            collect_context_results(Remaining - 1, maps:put(Message, {Trace, Span}, Values))
    after 5000 ->
        error({timeout, context_results, Remaining})
    end.

collect_clears(0, Values) -> Values;
collect_clears(Remaining, Values) ->
    receive
        {context_cleared, Pid, Context} ->
            collect_clears(Remaining - 1, [{Pid, Context} | Values])
    after 5000 ->
        error({timeout, context_clears, Remaining})
    end.

collect_otel_levels(0, Values) -> lists:reverse(Values);
collect_otel_levels(Remaining, Values) ->
    receive
        {otel_level, Value} -> collect_otel_levels(Remaining - 1, [Value | Values])
    after 1000 ->
        error({timeout, otel_levels, Remaining})
    end.

collect_transport_order(0, Values) -> lists:reverse(Values);
collect_transport_order(Remaining, Values) ->
    receive
        {transport_order, Value} ->
            collect_transport_order(Remaining - 1, [Value | Values])
    after 1000 ->
        error({timeout, transport_order, Remaining})
    end.
