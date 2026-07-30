import gleam/erlang/process
import gleam/json
import gleam/list
import gleam/option.{Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers as logging

type Captured {
  Written(logging.LogRecord)
  Flushed
  ExitRecords(List(logging.LogRecord))
  Closed
}

type AuditEvent {
  AuditEvent(logging.LogEvent)
}

pub fn main() {
  gleeunit.main()
}

fn transport(subject: process.Subject(Captured)) -> logging.Transport {
  logging.Transport(
    write: fn(record) {
      process.send(subject, Written(record))
      Ok(Nil)
    },
    flush: fn() {
      process.send(subject, Flushed)
      Ok(Nil)
    },
    flush_on_exit: fn(records) {
      process.send(subject, ExitRecords(records))
      Ok(Nil)
    },
    close: fn() {
      process.send(subject, Closed)
      Ok(Nil)
    },
  )
}

fn fixture_options() -> logging.Options {
  let base =
    logging.options(
      "payments",
      "contract-test",
      fn() { "contract-record-1" },
      fn() { "2026-01-02T03:04:05.000Z" },
    )
  logging.Options(..base, name: Some("audit"), fields: [
    #("environment", json.string("test")),
  ])
}

pub fn matches_shared_record_fixture_test() {
  let subject = process.new_subject()
  let logger = logging.new(fixture_options(), transport(subject))
  let event =
    logging.error(logger, "payment failed 42", [
      json.string("payment failed"),
      json.int(42),
    ])
    |> logging.add_fields([#("orderId", json.string("order-42"))])
    |> logging.set_logged_in_user([#("id", json.string("user-1"))])
    |> logging.add_user([#("id", json.string("user-2"))])
    |> logging.add_trace("trace-1")
    |> logging.add_trace("trace-2")
    |> logging.add_routine_id("charge-card")
    |> logging.add_tags(["payments", "critical"])
    |> logging.add_context(json.object([#("attempt", json.int(2))]))
    |> logging.add_meta(json.object([#("source", json.string("fixture"))]))

  let assert Ok(sent) = logging.send(event)
  let assert Ok(Written(record)) = process.receive(subject, within: 1000)
  let expected =
    "{\"schema\":\"next-loggers/v1\",\"id\":\"contract-record-1\",\"timestamp\":\"2026-01-02T03:04:05.000Z\",\"level\":\"ERROR\",\"runtime\":\"contract-test\",\"appName\":\"payments\",\"message\":\"payment failed 42\",\"values\":[\"payment failed\",42],\"fields\":{\"environment\":\"test\",\"orderId\":\"order-42\"},\"name\":\"audit\",\"loggedInUser\":{\"id\":\"user-1\"},\"users\":[{\"id\":\"user-2\"}],\"traceId\":\"trace-1\",\"traceIds\":[\"trace-1\",\"trace-2\"],\"routineId\":\"charge-card\",\"tags\":[\"payments\",\"critical\"],\"context\":[{\"attempt\":2}],\"meta\":[{\"source\":\"fixture\"}]}"

  logging.record_to_string(record)
  |> should.equal(expected)

  let assert Ok(_) = logging.send(sent)
  process.receive(subject, within: 10)
  |> should.equal(Error(Nil))

  let AuditEvent(inner) = AuditEvent(sent)
  logging.record(inner).level
  |> should.equal(logging.ErrorLevel)
}

pub fn shutdown_recovers_unsent_events_test() {
  let subject = process.new_subject()
  let logger = logging.new(fixture_options(), transport(subject))
  let _unsent = logging.warn(logger, "drain me", [json.string("drain me")])

  logging.flush_on_exit(logger)
  |> should.equal(Ok(Nil))

  let assert Ok(Written(record)) = process.receive(subject, within: 1000)
  record.message |> should.equal("drain me")
  let assert Ok(ExitRecords(records)) = process.receive(subject, within: 1000)
  records |> list.length |> should.equal(1)
  process.receive(subject, within: 1000)
  |> should.equal(Ok(Flushed))
}

pub fn level_filter_and_send_false_test() {
  let subject = process.new_subject()
  let options =
    logging.Options(..fixture_options(), minimum_level: logging.Warn)
  let logger = logging.new(options, transport(subject))

  let assert Ok(info) =
    logging.info(logger, "filtered", [json.string("filtered")])
    |> logging.send
  let assert Ok(local) =
    logging.warn(logger, "local", [json.string("local")])
    |> logging.send_with_store(False)

  logging.record(info).message |> should.equal("filtered")
  logging.record(local).message |> should.equal("local")
  process.receive(subject, within: 10)
  |> should.equal(Error(Nil))
}
