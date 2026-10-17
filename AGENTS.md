# fleet-telemetry agents

- Read `README.md`. Effect 4.0.0 is the pin; check Effect APIs against source (`effect_source`) before using them.
- Never commit hostnames, IPs, tokens or private paths. Use env vars and documented defaults.
- ClickHouse DDL is written as a plan file and applied only after review. The collector never auto-creates tables.
- Commit as shitratgit[bot].
