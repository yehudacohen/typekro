#!/bin/bash

set -euo pipefail

# Keep socket-backed transport tests in a dedicated process so listener state
# cannot interact with the broad suite.
bun test --timeout 10000 test/unit/bun-watch.test.ts
bun test --timeout 10000 $(find test -name '*.test.ts' | grep -v integration | grep -v 'test/unit/bun-watch.test.ts')
