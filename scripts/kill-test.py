#!/usr/bin/env python3
"""Local-only outage proof. No caller-supplied database endpoint is accepted.
Lifecycle sketch (XState v5): setup -> healthy -> outage -> restartCollector ->
restore -> drain -> verify -> done. Every state failure -> cleanup -> failed.
Only PIDs created here are stopped. Scratch and evidence survive failures.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[1]
LOOPBACK = "127.0.0.1"  # Never bind an external interface in the proof.
FIXTURE = json.loads((REPO / "apps/collector/redaction-fixture.json").read_text())


def free_port():
    with socket.socket() as sock:
        sock.bind((LOOPBACK, 0))
        return sock.getsockname()[1]


def request(url, data=None, timeout=2):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as response:
        return response.read().decode()


def wait_for(check, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    raise TimeoutError("Readiness/drain deadline exceeded")


def stop(process, hard=False):
    if process is not None and process.poll() is None:
        process.send_signal(signal.SIGKILL if hard else signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def payloads(sequence, size, run_id):
    now = time.time_ns()
    attrs = [{"key": "test.run_id", "value": {"stringValue": run_id}}] + FIXTURE["attributes"]
    resource = {"attributes": [{"key": "service.name", "value": {"stringValue": FIXTURE["serviceName"]}}] + attrs}
    scope = {"name": "kill-test", "attributes": attrs}
    spans, logs = [], []
    for index in range(size):
        unique = sequence * size + index + 1
        trace_id, span_id = f"{unique:032x}", f"{unique:016x}"
        spans.append({"traceId": trace_id, "spanId": span_id, "name": "proof.operation", "kind": 1, "startTimeUnixNano": str(now), "endTimeUnixNano": str(now + 1000), "attributes": attrs, "status": {"message": "CANARY_NOT_A_SECRET"}, "events": [{"name": "proof.event", "timeUnixNano": str(now), "attributes": attrs}]})
        logs.append({"timeUnixNano": str(now), "severityNumber": 9, "severityText": "INFO", "body": {"stringValue": FIXTURE["body"]}, "traceId": trace_id, "spanId": span_id, "attributes": attrs})
    metric_data = {"attributes": attrs, "timeUnixNano": str(now), "startTimeUnixNano": str(now - 1000000)}
    metrics = []
    for kind, fields in [
        ("gauge", {"asDouble": 1}),
        ("sum", {"asDouble": 1}),
        ("summary", {"count": "1", "sum": 1, "quantileValues": [{"quantile": 0.5, "value": 1}]}),
        ("histogram", {"count": "1", "sum": 1, "bucketCounts": ["1", "0"], "explicitBounds": [2]}),
        ("exponentialHistogram", {"count": "1", "sum": 1, "scale": 0, "zeroCount": "0", "positive": {"offset": 0, "bucketCounts": ["1"]}}),
    ]:
        data = {"dataPoints": [metric_data | fields]}
        if kind in ["sum", "histogram", "exponentialHistogram"]:
            data["aggregationTemporality"] = 1
        metrics.append({"name": f"proof.{kind}", kind: data})
    return {
        "traces": {"resourceSpans": [{"resource": resource, "scopeSpans": [{"scope": scope, "spans": spans}]}]},
        "logs": {"resourceLogs": [{"resource": resource, "scopeLogs": [{"scope": scope, "logRecords": logs}]}]},
        "metrics": {"resourceMetrics": [{"resource": resource, "scopeMetrics": [{"scope": scope, "metrics": metrics}]}]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outage-seconds", type=int, default=600)
    parser.add_argument("--rows-per-request", type=int, default=20)
    args = parser.parse_args()
    assert args.outage_seconds > 0 and args.rows_per_request > 0
    root = Path(os.environ["KILL_TEST_ROOT"]).resolve()
    assert root.is_dir() and not root.is_relative_to(REPO)
    work = Path(tempfile.mkdtemp(prefix="kill-test-", dir=root))
    (work / "data").mkdir()
    os.chmod(work, 0o700)
    ports = {name: free_port() for name in ["http", "grpc", "health", "metrics", "clickhouse"]}
    assert len(set(ports.values())) == len(ports)
    ch_url = f'http://{LOOPBACK}:{ports["clickhouse"]}'
    otlp_url = f'http://{LOOPBACK}:{ports["http"]}'
    metrics_url = f'http://{LOOPBACK}:{ports["metrics"]}/metrics'
    config = work / "clickhouse.xml"
    config.write_text(f"""<clickhouse>
<logger><level>warning</level><log>{work}/clickhouse.log</log><errorlog>{work}/clickhouse-error.log</errorlog></logger>
<path>{work}/data/</path><tmp_path>{work}/tmp/</tmp_path><user_files_path>{work}/user_files/</user_files_path>
<listen_host>{LOOPBACK}</listen_host><http_port>{ports['clickhouse']}</http_port>
<max_connections>128</max_connections><max_thread_pool_size>256</max_thread_pool_size>
<background_pool_size>16</background_pool_size><background_schedule_pool_size>4</background_schedule_pool_size>
<background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
<mark_cache_size>536870912</mark_cache_size><max_server_memory_usage>2147483648</max_server_memory_usage>
<users><default><password></password><networks><ip>{LOOPBACK}</ip></networks><profile>default</profile><quota>default</quota></default></users>
<profiles><default><max_threads>4</max_threads></default></profiles><quotas><default/></quotas>
</clickhouse>""")
    env = dict(os.environ) | {
        "CLICKHOUSE_ENDPOINT": ch_url, "CLICKHOUSE_USERNAME": "default", "CLICKHOUSE_PASSWORD": "",
        "OTEL_BIND": LOOPBACK, "OTEL_HEALTH_BIND": LOOPBACK,
        "OTEL_HTTP_PORT": str(ports["http"]), "OTEL_GRPC_PORT": str(ports["grpc"]),
        "OTEL_HEALTH_PORT": str(ports["health"]), "OTEL_METRICS_PORT": str(ports["metrics"]),
        "OTEL_DATA_DIR": str(work / "collector"), "OTEL_COLLECTOR_HOST": "proof",
    }
    ch, collector = None, None
    handles = []
    processes = []
    result = {"outage_seconds_requested": args.outage_seconds, "requests": 0, "sender_errors": 0, "max_sender_seconds": 0.0, "queue_peak_requests": 0}
    started = time.monotonic()

    def start_ch():
        handle = open(work / "clickhouse-console.log", "a")
        handles.append(handle)
        process = subprocess.Popen([os.environ["CLICKHOUSE_BINARY"], "server", f"--config-file={config}"], stdout=handle, stderr=handle, cwd=work)
        processes.append(process)
        wait_for(lambda: request(ch_url + "/ping") == "Ok.\n")
        return process

    def start_collector():
        handle = open(work / "collector.log", "a")
        handles.append(handle)
        process = subprocess.Popen([os.environ["OTELCOL_BINARY"], "--config", str(REPO / "apps/collector/collector.yaml")], env=env, stdout=handle, stderr=handle, cwd=work)
        processes.append(process)
        wait_for(lambda: request(f'http://{LOOPBACK}:{ports["health"]}/'))
        return process

    def sql(query):
        # Fixed local URL built above. Never use CLICKHOUSE_ENDPOINT from caller.
        return request(ch_url, query.encode(), timeout=10).strip()

    def sample_queue():
        text = request(metrics_url)
        values = [float(line.rsplit(" ", 1)[1]) for line in text.splitlines() if re.match(r"otelcol_exporter_queue_size(?:\{| )", line)]
        assert values, "No queue-size metrics found"
        depth = sum(values)
        result["queue_peak_requests"] = max(result["queue_peak_requests"], depth)
        (work / "last-metrics.prom").write_text(text)
        return depth

    def send(sequence):
        for kind, payload in payloads(sequence, args.rows_per_request, work.name).items():
            before = time.monotonic()
            try:
                response = json.loads(request(otlp_url + "/v1/" + kind, json.dumps(payload).encode()))
            except Exception:
                result["sender_errors"] += 1
                raise
            elapsed = time.monotonic() - before
            result["max_sender_seconds"] = max(result["max_sender_seconds"], elapsed)
            assert not response.get("partialSuccess"), response
            assert elapsed < 2, f"Sender blocked for {elapsed}s"
            result["requests"] += 1

    print(json.dumps({"state": "setup", "evidence": str(work)}), flush=True)
    try:
        version = subprocess.check_output([os.environ["CLICKHOUSE_BINARY"], "--version"], text=True).strip()
        assert "24.12.6.70" in version, version
        collector_version = subprocess.check_output([os.environ["OTELCOL_BINARY"], "--version"], text=True).strip()
        assert "0.163.1" in collector_version, collector_version
        result["versions"] = {"clickhouse": version, "collector": collector_version}
        ch = start_ch()
        ddl = re.sub(r"(?m)^--.*$", "", (REPO / "plans/clickhouse-otel-ddl.sql").read_text())
        for statement in ddl.split(";"):
            if statement.strip():
                sql(statement)
        assert sql("SELECT count() FROM system.tables WHERE database='otel'") == "9"
        collector = start_collector()
        send(0)
        wait_for(lambda: sql("SELECT count() FROM otel.otel_traces") == str(args.rows_per_request))
        print(json.dumps({"state": "outage", "seconds": args.outage_seconds}), flush=True)
        stop(ch)
        outage_start = time.monotonic()
        try:
            request(ch_url + "/ping")
            raise AssertionError("ClickHouse still reachable")
        except OSError:
            pass
        sequence = 1
        deadline = outage_start + args.outage_seconds
        while time.monotonic() < deadline:
            tick = time.monotonic()
            send(sequence)
            sequence += 1
            sample_queue()
            time.sleep(max(0, 1 - (time.monotonic() - tick)))
        # Requests are already on disk; batching runs after durable enqueue.
        before_restart = sample_queue()
        assert before_restart > 0
        stop(collector, hard=True)
        collector = start_collector()  # recovery while ClickHouse is STILL down
        after_restart = sample_queue()
        assert after_restart > 0, "Persistent queue did not survive SIGKILL"
        result["queue_before_restart"] = before_restart
        result["queue_after_restart"] = after_restart
        result["outage_seconds_actual"] = round(time.monotonic() - outage_start, 3)
        ch = start_ch()
        print(json.dumps({"state": "drain", **result}), flush=True)
        expected = sequence * args.rows_per_request
        def drained():
            depth = sample_queue()
            return depth == 0 and sql("SELECT count() FROM otel.otel_traces") == str(expected) and sql("SELECT count() FROM otel.otel_logs") == str(expected)
        wait_for(drained, seconds=180)
        counts = {table: int(sql(f"SELECT count() FROM otel.{table}")) for table in ["otel_traces", "otel_logs"] + ["otel_metrics_" + suffix for suffix in ["gauge", "sum", "summary", "histogram", "exponential_histogram"]]}
        assert counts["otel_logs"] == counts["otel_traces"] == expected, counts
        assert all(counts["otel_metrics_" + suffix] == sequence for suffix in ["gauge", "sum", "summary", "histogram", "exponential_histogram"]), counts
        assert sql("SELECT uniqExact(SpanId) FROM otel.otel_traces") == str(expected)
        assert sql("SELECT uniqExact(SpanId) FROM otel.otel_logs") == str(expected)
        for table, attr in [("otel_traces", "SpanAttributes"), ("otel_logs", "LogAttributes"), ("otel_metrics_gauge", "Attributes")]:
            for column in [attr, "ResourceAttributes"]:
                assert sql(f"SELECT count() FROM otel.{table} WHERE mapContains({column}, 'api.token') OR mapContains({column}, 'PASSWORD')") == "0", (table, column)
            assert sql(f"SELECT count() FROM otel.{table} WHERE ResourceAttributes['collector.host'] != 'proof'") == "0"
            for column in [attr, "ResourceAttributes"] + (["ScopeAttributes"] if table != "otel_traces" else []):
                for key in ["url.full", "http.url", "http.target", "url.query", "url.path"]:
                    assert sql(f"SELECT count() FROM otel.{table} WHERE mapContains({column}, '{key}')") == "0"
                assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['custom.reference'] != 'https://example.invalid/status'") == "0"
                assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['event.name'] != 'celld.request.failed'") == "0"
        assert sql("SELECT count() FROM otel.otel_logs WHERE Body != '<redacted>'") == "0"
        assert sql("SELECT count() FROM otel.otel_traces WHERE StatusMessage != ''") == "0"
        result["redaction_fixture"] = "celld bodies, URL keys, query strings and secret-shaped keys scrubbed; event.name preserved"
        result.update({"counts": counts, "expected_spans_and_logs": expected, "queue_final_requests": sample_queue(), "elapsed_seconds": round(time.monotonic() - started, 3), "passed": True})
        (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"state": "done", **result}), flush=True)
    except Exception as error:
        result.update({"passed": False, "error": str(error)})
        (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"state": "failed", **result}), flush=True)
        raise
    finally:
        for process in reversed(processes):
            stop(process)
        for handle in handles:
            handle.close()


if __name__ == "__main__":
    main()
