#!/bin/bash

# Run unit tests (excluding integration tests)
exec bun test $(find test -name '*.test.ts' | grep -v integration)