#!/bin/bash

# Script to organize imports only (used during commits)
# This temporarily enables import organization, runs it, then disables it

set -e

echo "📦 Organizing imports..."

# Backup the current biome.json
cp biome.json biome.json.backup

# Temporarily enable import organization in the main config
sed 's/"organizeImports": "off"/"organizeImports": "on"/' biome.json > biome.json.temp
mv biome.json.temp biome.json

# Run biome with only assist enabled (no formatter or linter)
# This will only organize imports, not remove unused ones or show linting errors
bunx biome check --write --formatter-enabled=false --linter-enabled=false src examples test

# Restore the original config
mv biome.json.backup biome.json

echo "✅ Import organization complete"