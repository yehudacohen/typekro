#!/bin/bash

# CI Quality Check for TypeKro
# This script runs all quality checks in CI/CD environment

set -e

echo "🚀 Running CI quality checks..."

# Check code formatting
echo "📝 Checking code formatting..."
if ! bun run format --check src examples test; then
  echo "❌ Code formatting check failed. Run 'bun run format:fix' to fix."
  exit 1
fi

# Check linting
echo "🧹 Checking linting..."
if ! bun run lint:ci; then
  echo "❌ Linting check failed. Run 'bun run lint:fix' to fix."
  exit 1
fi

# Run type checking
echo "🔍 Type checking..."
if ! bun run typecheck; then
  echo "❌ Type checking failed."
  exit 1
fi

# Run tests
echo "🧪 Running tests..."
if ! bun run test; then
  echo "❌ Tests failed."
  exit 1
fi

echo "✅ All CI quality checks passed!"