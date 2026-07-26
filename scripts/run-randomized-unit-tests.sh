#!/bin/bash

set -euo pipefail

# Keep socket-backed transport tests in a dedicated process, then randomize the
# remaining suite independently.
bun test --timeout 10000 test/unit/bun-watch.test.ts
bun test --randomize --seed=1 --timeout 10000 $(find test -name '*.test.ts' | grep -v integration | grep -v 'test/unit/bun-watch.test.ts')
