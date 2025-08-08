#!/bin/bash

# Pre-commit hook for TypeKro
# This script runs quality checks before allowing commits

set -e

echo "🔍 Running pre-commit checks..."

# Format code
echo "📝 Formatting code..."
bun run format:fix

# Organize imports
echo "📦 Organizing imports..."
bun run imports:organize

# Run type checking
echo "🔍 Type checking..."
bun run typecheck

# Run linting
echo "🧹 Linting..."
bun run lint

# Run tests
echo "🧪 Running tests..."
bun run test

echo "✅ All pre-commit checks passed!"