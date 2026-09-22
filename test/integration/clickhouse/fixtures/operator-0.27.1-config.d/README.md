# Altinity clickhouse-operator 0.27.1: default system-log config files

These are copied verbatim from the `configs.configdFiles` values of the
`altinity-clickhouse-operator` Helm chart, version 0.27.1
(`helm show values altinity-clickhouse-operator --repo https://helm.altinity.com --version 0.27.1`).
The operator writes them into every ClickHouse server's `config.d`.

Only the system-log files are vendored. They are the ones that conflict with
per-log `configuration.settings` (#235): each replaces its section with one
that declares a full `<engine>`, and `01-clickhouse-03-query_log.xml` also
removes `query_thread_log`.

`../system-logs-server-boot.test.ts` boots a real ClickHouse server with these
files next to the configuration TypeKro renders.
