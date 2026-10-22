"""OpenTelemetry for ARI: traces, metrics, events and logs (MELT).

Every API request, every decision and every step inside it is a span: the
Propensity Router, the rules, Thompson sampling, the review gate and the send.
Span events mark what happened along the way (a rule blocked a treatment, a
decision went to review). Metrics count decisions, routes, contacts and
outcomes and time each decision. Log records carry the trace they belong to.

The console reads all four from memory (Admin > Observability). Set
OTEL_EXPORTER_OTLP_ENDPOINT to also send traces, metrics and logs to any OTLP
collector (Jaeger, Grafana Tempo, Honeycomb, Datadog...).
"""
from __future__ import annotations

import logging
import os
import threading
from collections import deque
from typing import Sequence

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs import LogData
from opentelemetry.sdk._logs.export import LogExporter, LogExportResult, SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter, SpanExportResult

SERVICE = "ari-recovery-engine"
VERSION = "4.2.1"
MAX_SPANS = 5000


class RingSpanExporter(SpanExporter):
    """Keeps the most recent finished spans in memory for the console."""

    def __init__(self, size: int = MAX_SPANS) -> None:
        self._spans: deque[ReadableSpan] = deque(maxlen=size)
        self._lock = threading.Lock()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._lock:
            self._spans.extend(spans)
        return SpanExportResult.SUCCESS

    def spans(self) -> list[ReadableSpan]:
        with self._lock:
            return list(self._spans)

    def shutdown(self) -> None:
        pass


class RingLogExporter(LogExporter):
    """Keeps the most recent log records in memory for the console."""

    def __init__(self, size: int = MAX_SPANS) -> None:
        self._logs: deque[LogData] = deque(maxlen=size)
        self._lock = threading.Lock()

    def export(self, batch: Sequence[LogData]) -> LogExportResult:
        with self._lock:
            self._logs.extend(batch)
        return LogExportResult.SUCCESS

    def logs(self) -> list[LogData]:
        with self._lock:
            return list(self._logs)

    def shutdown(self) -> None:
        pass


resource = Resource.create({"service.name": SERVICE, "service.version": VERSION,
                            "service.namespace": "ari", "deployment.environment": os.getenv("ARI_ENV", "pilot")})

spans = RingSpanExporter()
_tracer_provider = TracerProvider(resource=resource)
_tracer_provider.add_span_processor(SimpleSpanProcessor(spans))

metric_reader = InMemoryMetricReader()
_readers = [metric_reader]

log_exporter = RingLogExporter()
_logger_provider = LoggerProvider(resource=resource)
_logger_provider.add_log_record_processor(SimpleLogRecordProcessor(log_exporter))

OTLP_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
if OTLP_ENDPOINT:   # also ship everything to a collector
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    _tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    _readers.append(PeriodicExportingMetricReader(OTLPMetricExporter()))
    _logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))

trace.set_tracer_provider(_tracer_provider)
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=_readers))
set_logger_provider(_logger_provider)

tracer = trace.get_tracer("ari.engine", VERSION)
meter = metrics.get_meter("ari.engine", VERSION)

# The application's own log, correlated with traces. Only ARI's loggers, not every library's.
log = logging.getLogger("ari")
log.setLevel(logging.INFO)
if not any(isinstance(h, LoggingHandler) for h in log.handlers):
    log.addHandler(LoggingHandler(level=logging.INFO, logger_provider=_logger_provider))

# --- metrics --------------------------------------------------------------
decisions = meter.create_counter("ari.decisions", unit="{decision}",
                                 description="Decisions made, by strategy, group and review")
decision_latency = meter.create_histogram("ari.decision.duration", unit="ms",
                                          description="Time to make one decision")
routes = meter.create_counter("ari.router.routes", unit="{customer}",
                              description="Customers routed by the Propensity Router, by fit group and route")
contacts = meter.create_counter("ari.contacts", unit="{contact}",
                                description="Contacts attempted, by channel and status")
outcomes = meter.create_counter("ari.outcomes", unit="{outcome}",
                                description="Outcomes recorded, by group and whether paid")
rule_blocks = meter.create_counter("ari.rules.blocked", unit="{rule}",
                                   description="Treatments blocked by a rule, by rule")


def instrument(app) -> None:
    """HTTP server spans for every API request."""
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app, tracer_provider=_tracer_provider, meter_provider=metrics.get_meter_provider(),
                                       excluded_urls="health,healthz", server_request_hook=_redact_query)


def _redact_query(span, scope) -> None:
    """Query strings can carry names (a search for a customer), so traces keep the path only."""
    if span is None or not span.is_recording() or not scope.get("query_string"):
        return
    path = scope.get("path", "")
    span.set_attribute("http.target", path + "?[redacted]")
    for key in ("http.url", "url.full"):
        span.set_attribute(key, f"{scope.get('scheme', 'http')}://{dict(scope.get('headers') or []).get(b'host', b'').decode()}{path}?[redacted]")
    span.set_attribute("url.query", "[redacted]")
