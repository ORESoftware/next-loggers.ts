package cloud.oresoftware.nextloggers;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public final class NextLoggersTest {
  private NextLoggersTest() {}

  public static void main(String[] args) throws Exception {
    List<Map<String, Object>> otel = new ArrayList<>();
    List<Map<String, Object>> supabase = new ArrayList<>();
    NextLoggers.Logger logger =
        new NextLoggers.Logger(
            "payments",
            "audit",
            "java",
            Map.of("environment", "test"),
            List.of(
                new NextLoggers.OtelTransport(otel::add),
                new NextLoggers.SupabaseTransport(supabase::add)));

    Map<String, Object> record =
        NextLoggers.withContext(
            new NextLoggers.Context(
                "0123456789abcdef0123456789abcdef",
                "0123456789abcdef",
                1,
                "vendor=value",
                Map.of("requestId", "request-1"),
                List.of("otel", "checkout")),
            () -> logger.error("payment failed", Map.of("orderId", "order-42")));

    assert NextLoggers.SCHEMA.equals(record.get("schema"));
    assert "payments".equals(record.get("appName"));
    assert "ERROR".equals(record.get("level"));
    assert "0123456789abcdef0123456789abcdef".equals(record.get("traceId"));
    @SuppressWarnings("unchecked")
    Map<String, Object> fields = (Map<String, Object>) record.get("fields");
    assert "0123456789abcdef".equals(fields.get("otel.span_id"));
    assert "request-1".equals(fields.get("requestId"));
    assert "order-42".equals(fields.get("orderId"));
    assert otel.size() == 1;
    assert Integer.valueOf(17).equals(otel.get(0).get("severityNumber"));
    assert supabase.size() == 1;
    assert NextLoggers.toJson(record).contains("\"schema\":\"next-loggers/v1\"");
    assert NextLoggers.currentContext() == null : "context was not restored";

    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Callable<String>> calls =
          List.of(
              () ->
                  NextLoggers.withContext(
                      NextLoggers.Context.trace("trace-a", "span-a"),
                      () -> String.valueOf(logger.info("a", Map.of()).get("traceId"))),
              () ->
                  NextLoggers.withContext(
                      NextLoggers.Context.trace("trace-b", "span-b"),
                      () -> String.valueOf(logger.info("b", Map.of()).get("traceId"))));
      List<Future<String>> futures = pool.invokeAll(calls);
      assert "trace-a".equals(futures.get(0).get());
      assert "trace-b".equals(futures.get(1).get());
    } finally {
      pool.shutdownNow();
      if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
        throw new AssertionError("executor did not terminate");
      }
    }

    List<Map<String, Object>> routedOtel = new ArrayList<>();
    List<Map<String, Object>> routedAll = new ArrayList<>();
    NextLoggers.Logger routed =
        new NextLoggers.Logger(
            "checkout",
            List.of(
                new NextLoggers.OtelTransport(routedOtel::add),
                new NextLoggers.SupabaseTransport(routedAll::add)));
    routed.info("default on", Map.of());
    routed.notOtel().warn("opted out", Map.of());
    routed.notOtel().useOtel().error("opted back in", Map.of());
    assert routedOtel.size() == 2 : "notOtel() must skip the OTEL transport";
    assert "default on".equals(routedOtel.get(0).get("body"));
    assert "opted back in".equals(routedOtel.get(1).get("body"));
    assert routedAll.size() == 3 : "other transports must receive every record";
    assert routed.otelEnabled() : "notOtel() must return a derived logger";

    System.out.println("Java next-loggers conformance passed");
  }
}
