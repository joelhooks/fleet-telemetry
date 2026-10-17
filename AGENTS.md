# fleet-telemetry agents

- Read `README.md`. Effect 4.0.5 is the dev pin (matching alchemy-proxmox and alchemy-nest); packages declare effect as a peer range consumers can satisfy; check Effect APIs against source (`effect_source`) before using them.
- Never commit hostnames, IPs, tokens or private paths. Use env vars and documented defaults.
- ClickHouse DDL is written as a plan file and applied only after review. The collector never auto-creates tables.
- Commit as shitratgit[bot].
