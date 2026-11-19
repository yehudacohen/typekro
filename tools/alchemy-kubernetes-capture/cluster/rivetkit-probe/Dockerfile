# Built locally for the cluster run; OrbStack's Kubernetes uses the same Docker image store.
FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e
WORKDIR /probe
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY probe.ts ./
CMD ["bun", "probe.ts"]
