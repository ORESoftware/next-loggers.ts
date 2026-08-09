-module(next_loggers).

-export([
    new/3,
    new/4,
    current_context/0,
    with_context/2,
    event/4,
    send/1,
    with_otel/2,
    use_otel/1,
    not_otel/1,
    reset_otel/1,
    is_otel_enabled/2,
    set_otel_enabled/2,
    log/4,
    info/3,
    error/3,
    otel_transport/1,
    supabase_transport/1
]).

-define(SCHEMA, <<"next-loggers/v1">>).
-define(CONTEXT_KEY, '$next_loggers_context').

new(AppName, Runtime, Transports) ->
    new(AppName, Runtime, #{}, Transports).

new(AppName, Runtime, Fields, Transports)
        when is_binary(AppName), is_binary(Runtime), is_map(Fields), is_list(Transports) ->
    case byte_size(AppName) of
        0 -> error({invalid_app_name, AppName});
        _ -> #{app_name => AppName, runtime => Runtime, fields => Fields, transports => Transports, otel => true}
    end.

current_context() ->
    case erlang:get(?CONTEXT_KEY) of
        undefined -> #{};
        Context when is_map(Context) -> Context
    end.

%% Process dictionary scope is local to the current lightweight BEAM process.
%% The previous frame is restored even when the callback throws.
with_context(Context, Fun) when is_map(Context), is_function(Fun, 0) ->
    Previous = erlang:get(?CONTEXT_KEY),
    erlang:put(?CONTEXT_KEY, Context),
    try Fun()
    after
        case Previous of
            undefined -> erlang:erase(?CONTEXT_KEY);
            _ -> erlang:put(?CONTEXT_KEY, Previous)
        end
    end.

info(Logger, Message, Fields) ->
    log(Logger, <<"INFO">>, Message, Fields).

error(Logger, Message, Fields) ->
    log(Logger, <<"ERROR">>, Message, Fields).

log(Logger, Level, Message, EventFields)
        when is_map(Logger), is_binary(Level), is_binary(Message), is_map(EventFields) ->
    send(event(Logger, Level, Message, EventFields)).

event(Logger, Level, Message, EventFields)
        when is_map(Logger), is_binary(Level), is_binary(Message), is_map(EventFields) ->
    #{
        kind => event,
        logger => Logger,
        level => Level,
        message => Message,
        fields => EventFields,
        context => current_context(),
        otel_enabled => undefined
    }.

set_otel_enabled(Logger, Enabled) when is_map(Logger), is_boolean(Enabled) ->
    maps:put(otel, Enabled, Logger).

use_otel(Value) when is_map(Value) ->
    case maps:get(kind, Value, logger) of
        event -> with_otel(Value, true);
        logger -> set_otel_enabled(Value, true)
    end.

not_otel(Value) when is_map(Value) ->
    case maps:get(kind, Value, logger) of
        event -> with_otel(Value, false);
        logger -> set_otel_enabled(Value, false)
    end.

with_otel(Event, Enabled) when is_map(Event), is_boolean(Enabled) ->
    maps:put(otel_enabled, Enabled, Event).

reset_otel(Event) when is_map(Event) ->
    maps:put(otel_enabled, undefined, Event).

is_otel_enabled(Event, Fallback) when is_map(Event), is_boolean(Fallback) ->
    case maps:get(otel_enabled, Event, undefined) of
        undefined -> Fallback;
        Enabled -> Enabled
    end.

send(Event) when is_map(Event) ->
    Logger = maps:get(logger, Event),
    Level = maps:get(level, Event),
    Message = maps:get(message, Event),
    EventFields = maps:get(fields, Event),
    Context = maps:get(context, Event, #{}),
    LoggerFields = maps:get(fields, Logger, #{}),
    ContextFields = maps:get(fields, Context, #{}),
    Fields0 = maps:merge(LoggerFields, ContextFields),
    Fields1 = put_optional(<<"otel.span_id">>, maps:get(span_id, Context, undefined), Fields0),
    Fields2 = maps:put(<<"otel.trace_flags">>, maps:get(trace_flags, Context, 0), Fields1),
    Fields3 = put_optional(<<"otel.trace_state">>, maps:get(trace_state, Context, undefined), Fields2),
    Fields = maps:merge(Fields3, EventFields),
    TraceId = maps:get(trace_id, Context, undefined),
    Record0 = #{
        schema => ?SCHEMA,
        id => unique_id(),
        timestamp => timestamp(),
        level => Level,
        runtime => maps:get(runtime, Logger),
        appName => maps:get(app_name, Logger),
        message => Message,
        values => [Message],
        fields => Fields
    },
    Record1 = put_optional(traceId, TraceId, Record0),
    Record2 = case TraceId of
        undefined -> Record1;
        <<>> -> Record1;
        _ -> maps:put(traceIds, [TraceId], Record1)
    end,
    Tags = maps:get(tags, Context, []),
    Record = case Tags of
        [] -> Record2;
        _ -> maps:put(tags, Tags, Record2)
    end,
    OtelEnabled = is_otel_enabled(Event, maps:get(otel, Logger, true)),
    lists:foreach(
        fun(Transport) ->
            case is_otel_transport(Transport) andalso not OtelEnabled of
                true -> ok;
                false -> ok = deliver_transport(Transport, Record)
            end
        end,
        maps:get(transports, Logger, [])
    ),
    Record.

%% Application-owned OpenTelemetry adapter. It emits data but never installs
%% a tracer, logger provider, context manager, or automatic instrumentation.
otel_transport(Sink) when is_function(Sink, 1) ->
    {opentelemetry, fun(Record) ->
        Level = maps:get(level, Record),
        Fields = maps:get(fields, Record, #{}),
        Attributes0 = #{
            <<"service.name">> => maps:get(appName, Record),
            <<"next_logger.schema">> => maps:get(schema, Record),
            <<"next_logger.runtime">> => maps:get(runtime, Record),
            <<"log.record.uid">> => maps:get(id, Record)
        },
        Attributes1 = maps:fold(
            fun(Key, Value, Acc) ->
                maps:put(<<"next_logger.field.", (key_binary(Key))/binary>>, Value, Acc)
            end,
            Attributes0,
            Fields
        ),
        Attributes = put_optional(<<"trace.id">>, maps:get(traceId, Record, undefined), Attributes1),
        Sink(#{
            body => maps:get(message, Record),
            severityText => Level,
            severityNumber => severity_number(Level),
            timestamp => maps:get(timestamp, Record),
            attributes => Attributes
        }),
        ok
    end}.

%% Client transport with an injected authenticated Supabase sender.
supabase_transport(Sender) when is_function(Sender, 1) ->
    {supabase, fun(Record) -> Sender(Record), ok end}.

is_otel_transport({Name, _}) when Name =:= opentelemetry; Name =:= <<"opentelemetry">> -> true;
is_otel_transport(_) -> false.

deliver_transport({_Name, Transport}, Record) when is_function(Transport, 1) -> Transport(Record);
deliver_transport(Transport, Record) when is_function(Transport, 1) -> Transport(Record).

severity_number(<<"TRACE">>) -> 1;
severity_number(<<"DEBUG">>) -> 5;
severity_number(<<"INFO">>) -> 9;
severity_number(<<"WARN">>) -> 13;
severity_number(<<"ERROR">>) -> 17;
severity_number(<<"FATAL">>) -> 21.

put_optional(_Key, undefined, Map) -> Map;
put_optional(_Key, <<>>, Map) -> Map;
put_optional(Key, Value, Map) -> maps:put(Key, Value, Map).

key_binary(Key) when is_binary(Key) -> Key;
key_binary(Key) when is_atom(Key) -> atom_to_binary(Key, utf8);
key_binary(Key) -> unicode:characters_to_binary(io_lib:format("~p", [Key])).

unique_id() ->
    integer_to_binary(erlang:unique_integer([monotonic, positive])).

timestamp() ->
    list_to_binary(calendar:system_time_to_rfc3339(erlang:system_time(second), [
        {unit, second},
        {offset, "Z"}
    ])).
