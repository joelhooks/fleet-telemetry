#!/usr/bin/env python3
"""Local-only outage proof. No caller-supplied database endpoint is accepted.
Lifecycle sketch (XState v5): setup -> healthy -> outage -> restartCollector ->
restore -> drain -> verify -> done. Every state failure -> cleanup -> failed.
Only PIDs created here are stopped. Scratch and evidence survive failures.
"""
import argparse
import hashlib
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
# Deliberately use a second local loopback address, never a real network interface.
SECOND_BIND = "127.0.0.2"
USAGE = {a["key"]: a["value"]["intValue"] for a in FIXTURE["attributes"] if a["key"].startswith("gen_ai.usage.") and a["key"] != "gen_ai.usage.unlisted_tokens"}


def usage_case(attrs, non_integer=False):
    # Alternate records to prove a preceding integer cannot leak through cache.
    return [a if not non_integer or a["key"] not in USAGE else a | {"value": {"stringValue": "123"}} for a in attrs] + [{"key": "test.usage_case", "value": {"stringValue": "non_integer" if non_integer else "int"}}]


def free_port():
    with socket.socket() as sock:
        sock.bind((LOOPBACK, 0))
        return sock.getsockname()[1]


def request(url, data=None, timeout=2):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    # Never let a machine-wide HTTP proxy forward the local synthetic fixture.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as response:
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
        spans.append({"traceId": trace_id, "spanId": span_id, "name": "proof.operation", "kind": 1, "startTimeUnixNano": str(now), "endTimeUnixNano": str(now + 1000), "attributes": usage_case(attrs, index % 2 == 1), "status": {"message": "CANARY_NOT_A_SECRET"}, "events": [{"name": "proof.event", "timeUnixNano": str(now), "attributes": usage_case(attrs, index % 2 == 1)}]})
        logs.append({"timeUnixNano": str(now), "severityNumber": 9, "severityText": "INFO", "body": {"stringValue": FIXTURE["body"]}, "traceId": trace_id, "spanId": span_id, "attributes": usage_case(attrs, index % 2 == 1)})
    metric_data = {"attributes": usage_case(attrs, sequence % 2 == 1), "timeUnixNano": str(now), "startTimeUnixNano": str(now - 1000000)}
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
    ports = {name: free_port() for name in ["http", "grpc", "loopback_http", "loopback_grpc", "health", "metrics", "clickhouse"]}
    assert len(set(ports.values())) == len(ports)
    ch_url = f'http://{LOOPBACK}:{ports["clickhouse"]}'
    otlp_url = f'http://{LOOPBACK}:{ports["loopback_http"]}'
    second_otlp_url = f'http://{SECOND_BIND}:{ports["http"]}'
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
        "OTEL_TAILNET_BIND": SECOND_BIND, "OTEL_HEALTH_BIND": LOOPBACK,
        "OTEL_HTTP_PORT": str(ports["http"]), "OTEL_GRPC_PORT": str(ports["grpc"]),
        "OTEL_LOOPBACK_HTTP_PORT": str(ports["loopback_http"]), "OTEL_LOOPBACK_GRPC_PORT": str(ports["loopback_grpc"]),
        "OTEL_HEALTH_PORT": str(ports["health"]), "OTEL_METRICS_PORT": str(ports["metrics"]),
        "OTEL_DATA_DIR": str(work / "collector"), "OTEL_COLLECTOR_HOST": "proof",
    }
    ch, collector = None, None
    handles = []
    processes = []
    result = {"outage_seconds_requested": args.outage_seconds, "requests": 0, "sender_errors": 0, "max_sender_seconds": 0.0, "queue_peak_bytes": 0, "otlp_json_bytes_total": 0, "otlp_json_bytes_max": 0}
    result["queue_capacity_bytes_per_signal"] = int(env.get("OTEL_QUEUE_BYTES", "21474836480"))
    result["queue_peak_bytes_by_signal"] = {kind: 0 for kind in ["traces", "logs", "metrics"]}
    result["source_sha256"] = {name: hashlib.sha256((REPO / name).read_bytes()).hexdigest() for name in ["apps/collector/collector.yaml", "scripts/collector.sh", "scripts/kill-test.py", "apps/collector/redaction-fixture.json"]}
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
        process = subprocess.Popen(["/bin/sh", str(REPO / "scripts/collector.sh"), os.environ["OTELCOL_BINARY"], "--config", str(REPO / "apps/collector/collector.yaml")], env=env, stdout=handle, stderr=handle, cwd=work)
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
        for line in text.splitlines():
            match = re.match(r'otelcol_exporter_queue_size\{.*data_type="(traces|logs|metrics)"', line)
            if match:
                kind = match.group(1)
                result["queue_peak_bytes_by_signal"][kind] = max(result["queue_peak_bytes_by_signal"][kind], float(line.rsplit(" ", 1)[1]))
        depth = sum(values)
        result["queue_peak_bytes"] = max(result["queue_peak_bytes"], depth)
        capacities = [float(line.rsplit(" ", 1)[1]) for line in text.splitlines() if re.match(r"otelcol_exporter_queue_capacity(?:\{| )", line)]
        assert len(capacities) == 3 and all(c == result["queue_capacity_bytes_per_signal"] for c in capacities), capacities
        (work / "last-metrics.prom").write_text(text)
        return depth

    def send(sequence, endpoint=otlp_url):
        for kind, payload in payloads(sequence, args.rows_per_request, work.name).items():
            wire = json.dumps(payload).encode()
            before = time.monotonic()
            try:
                response = json.loads(request(endpoint + "/v1/" + kind, wire))
            except Exception:
                result["sender_errors"] += 1
                raise
            elapsed = time.monotonic() - before
            result["max_sender_seconds"] = max(result["max_sender_seconds"], elapsed)
            assert not response.get("partialSuccess"), response
            assert elapsed < 2, f"Sender blocked for {elapsed}s"
            result["requests"] += 1
            result["otlp_json_bytes_total"] += len(wire)
            result["otlp_json_bytes_max"] = max(result["otlp_json_bytes_max"], len(wire))

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
        send(1, endpoint=second_otlp_url)
        wait_for(lambda: sql("SELECT count() FROM otel.otel_traces") == str(2 * args.rows_per_request))
        wait_for(lambda: sample_queue() == 0)
        result["receivers_tested"] = ["loopback", "second local address standing in for tailnet"]
        result["loopback_and_tailnet_ports_distinct"] = True
        print(json.dumps({"state": "outage", "seconds": args.outage_seconds}), flush=True)
        stop(ch)
        outage_start = time.monotonic()
        try:
            request(ch_url + "/ping")
            raise AssertionError("ClickHouse still reachable")
        except OSError:
            pass
        sequence = 2
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
        storage_files = [p for p in (work / "collector/queue").rglob("*") if p.is_file()]
        result["queue_storage_file_bytes_at_restart"] = sum(p.stat().st_size for p in storage_files)
        result["queue_storage_allocated_bytes_at_restart"] = sum(p.stat().st_blocks * 512 for p in storage_files)
        stop(collector, hard=True)
        collector = start_collector()  # recovery while ClickHouse is STILL down
        after_restart = sample_queue()
        assert after_restart > 0, "Persistent queue did not survive SIGKILL"
        result["queue_before_restart_bytes"] = before_restart
        result["queue_after_restart_bytes"] = after_restart
        assert before_restart == after_restart, "Queued byte count changed across recovery"
        result["queued_requests_at_restart"] = (sequence - 2) * 3
        result["mean_queued_request_bytes"] = before_restart / result["queued_requests_at_restart"]
        result["mean_queued_request_bytes_by_signal"] = {kind: size / (sequence - 2) for kind, size in result["queue_peak_bytes_by_signal"].items()}
        result["mean_otlp_json_request_bytes"] = result["otlp_json_bytes_total"] / result["requests"]
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
        for table, attr in [("otel_traces", "SpanAttributes"), ("otel_logs", "LogAttributes")] + [("otel_metrics_" + suffix, "Attributes") for suffix in ["gauge", "sum", "summary", "histogram", "exponential_histogram"]]:
            for column in [attr, "ResourceAttributes"] + (["ScopeAttributes"] if table != "otel_traces" else []):
                for key in ["api.token", "api_token", "api_key", "PASSWORD", "foo_tokens", "gen_ai.usage.unlisted_tokens", "fleet.usage.unlisted_tokens"]:
                    assert sql(f"SELECT count() FROM otel.{table} WHERE mapContains({column}, '{key}')") == "0", (table, column, key)
                for key, value in USAGE.items():
                    if column == attr:
                        assert int(sql(f"SELECT count() FROM otel.{table} WHERE {column}['test.usage_case'] = 'int'")) > 0
                        assert int(sql(f"SELECT count() FROM otel.{table} WHERE {column}['test.usage_case'] = 'non_integer'")) > 0
                        assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['test.usage_case'] = 'int' AND {column}['{key}'] != '{value}'") == "0", (table, column, key)
                        assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['test.usage_case'] = 'non_integer' AND mapContains({column}, '{key}')") == "0", (table, column, key)
                    else:
                        assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['{key}'] != '{value}'") == "0", (table, column, key)
            assert sql(f"SELECT count() FROM otel.{table} WHERE ResourceAttributes['collector.host'] != 'proof'") == "0"
            for column in [attr, "ResourceAttributes"] + (["ScopeAttributes"] if table != "otel_traces" else []):
                for key in ["url.full", "http.url", "http.target", "url.query", "url.path"]:
                    assert sql(f"SELECT count() FROM otel.{table} WHERE mapContains({column}, '{key}')") == "0"
                assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['custom.reference'] != 'https://example.invalid/status'") == "0"
                assert sql(f"SELECT count() FROM otel.{table} WHERE {column}['event.name'] != 'celld.request.failed'") == "0"
        assert sql("SELECT count() FROM otel.otel_logs WHERE Body != '<redacted>'") == "0"
        assert sql("SELECT count() FROM otel.otel_traces WHERE StatusMessage != ''") == "0"
        for key, value in USAGE.items():
            assert sql(f"SELECT count() FROM otel.otel_traces WHERE SpanAttributes['test.usage_case'] = 'int' AND arrayExists(a -> a['{key}'] != '{value}', `Events.Attributes`)") == "0"
            assert sql(f"SELECT count() FROM otel.otel_traces WHERE SpanAttributes['test.usage_case'] = 'non_integer' AND arrayExists(a -> mapContains(a, '{key}'), `Events.Attributes`)") == "0"
        result["redaction_fixture"] = "celld bodies, URL keys, query strings and secret-shaped keys scrubbed; event.name preserved; five approved integer usage counters kept; string and unlisted token attributes dropped"
        result.update({"counts": counts, "expected_spans_and_logs": expected, "queue_final_bytes": sample_queue(), "elapsed_seconds": round(time.monotonic() - started, 3), "passed": True})
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
