#!/usr/bin/env python3
"""Render upstream SQL templates, never connect to a database. --check compares the plan."""
import argparse
import hashlib
from pathlib import Path
import re
import urllib.request

VERSION = "0.163.0"  # exporter version in the 0.163.1 distribution manifest
BASE = f"https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v{VERSION}/exporter/clickhouseexporter/internal/sqltemplates/"
PLAN = Path(__file__).resolve().parents[1] / "plans/clickhouse-otel-ddl.sql"


def render():
    statements = [
        "-- REVIEW PLAN ONLY. No deployment code applies this file.",
        "-- Copyright The OpenTelemetry Authors; SPDX-License-Identifier: Apache-2.0",
        f"-- otelcol-contrib 0.163.1 / clickhouseexporter {VERSION}.",
        f"-- Source: {BASE}",
        "-- Map attributes (json=false), no cluster, MergeTree(), ClickHouse 24.12 fallback indexes.",
        "-- TTL rendering follows internal.GenerateTTLExpr(720h, timeField).",
        "CREATE DATABASE IF NOT EXISTS otel;",
    ]
    names = ["logs_table.sql", "traces_table.sql", "traces_id_ts_lookup_table.sql", "traces_id_ts_lookup_mv.sql"]
    names += [f"metrics_{kind}_table.sql" for kind in ["gauge", "sum", "summary", "histogram", "exp_histogram"]]
    for name in names:
        with urllib.request.urlopen(BASE + name, timeout=30) as response:
            raw = response.read()
        text = raw.decode()
        if name == "logs_table.sql":
            text = re.sub(r"{{- if .HasFullTextSearch}}.*?{{- else}}(.*?){{- end}}", r"\1", text, flags=re.S)
            values = {"{{ident .Database}}": "`otel`", "{{ident .TableName}}": "`otel_logs`", "{{.ClusterString}}": "", "{{.Engine}}": "MergeTree()", "{{.TTL}}": "TTL toDateTime(Timestamp) + toIntervalDay(30)"}
            for key, value in values.items():
                text = text.replace(key, value)
        else:
            if name.startswith("metrics_"):
                suffix = name.removeprefix("metrics_").removesuffix("_table.sql").replace("exp_histogram", "exponential_histogram")
                values = ["otel", f"otel_metrics_{suffix}", "", "MergeTree()", "TTL toDateTime(TimeUnix) + toIntervalDay(30)"]
            elif name.endswith("_mv.sql"):
                values = ["otel", "otel_traces", "", "otel", "otel_traces", "otel", "otel_traces"]
            else:
                time_field = "Start" if "lookup" in name else "Timestamp"
                values = ["otel", "otel_traces", "", "MergeTree()", f"TTL toDateTime({time_field}) + toIntervalDay(30)"]
            # Go's %q is a quoted SQL identifier here, not a string literal.
            for value in values:
                text, count = re.subn(r"%([sq])", lambda m: f'"{value}"' if m[1] == "q" else value, text, count=1)
                assert count == 1, name
        assert not re.search(r"{{|%[sq]", text), name
        text = "\n".join(line.rstrip() for line in text.splitlines())
        statements += [f"\n-- {name}; upstream sha256: {hashlib.sha256(raw).hexdigest()}", text.strip() + ";"]
    return "\n".join(statements) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = render()
    if args.check:
        assert PLAN.read_text() == text, "DDL plan differs from upstream rendering"
        print("DDL plan matches all 9 upstream templates; 8 tables, 30-day TTLs, 1 materialized view")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
