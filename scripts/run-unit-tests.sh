#!/bin/bash

# Run unit tests (excluding integration tests) with 10 second timeout
exec bun test --timeout 10000 $(find test -name '*.test.ts' | grep -v integration)