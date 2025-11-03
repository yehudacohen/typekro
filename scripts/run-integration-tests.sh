#!/bin/bash

set -euo pipefail

# Check if debug mode is enabled
DEBUG_MODE=${DEBUG_MODE:-false}

echo "🚀 Starting Integration Test Suite..."
echo "====================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Please run this script from the typekro package directory"
    exit 1
fi

# Check dependencies
echo "🔍 Checking dependencies..."

# Check if bun is available
if ! command -v bun &> /dev/null; then
    echo "❌ bun is required but not installed. Please install bun first."
    exit 1
fi

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "⚠️  kubectl not found. E2E cluster tests will be skipped."
    SKIP_CLUSTER_TESTS=true
else
    echo "✅ kubectl found"
fi

# Check if kind is available
if ! command -v kind &> /dev/null; then
    echo "⚠️  kind not found. E2E cluster tests will be skipped."
    echo "   Install kind from: https://kind.sigs.k8s.io/docs/user/quick-start/"
    SKIP_CLUSTER_TESTS=true
else
    echo "✅ kind found"
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo "⚠️  Docker not running. E2E cluster tests will be skipped."
    SKIP_CLUSTER_TESTS=true
else
    echo "✅ Docker is running"
fi

echo ""

cleanup() {
  echo "\n🧹 Cleaning up integration test environment..."
  # Only cleanup if we created the cluster (not using existing cluster)
  if [ "${SKIP_CLUSTER_TESTS:-false}" != "true" ] && [ "$DEBUG_MODE" != "true" ] && [ "${CREATE_CLUSTER:-false}" = "true" ]; then
    bun run scripts/e2e-cleanup.ts || true
  fi
}
trap cleanup EXIT

# Setup cluster for integration tests
if [ "${SKIP_CLUSTER_TESTS:-false}" != "true" ]; then
  # Check if we should create a new kind cluster
  CREATE_CLUSTER=false
  
  if [ "${CREATE_KIND_CLUSTER:-false}" = "true" ]; then
    echo "🔧 CREATE_KIND_CLUSTER is set, will create new kind cluster..."
    CREATE_CLUSTER=true
  elif ! kubectl cluster-info &> /dev/null; then
    echo "🔧 No accessible Kubernetes cluster found, will create kind cluster..."
    CREATE_CLUSTER=true
  else
    echo "✅ Using existing Kubernetes cluster"
    CURRENT_CONTEXT=$(kubectl config current-context)
    echo "   Current context: $CURRENT_CONTEXT"
  fi
  
  # Export CREATE_CLUSTER so e2e-setup.ts knows whether to create cluster
  export CREATE_CLUSTER
  
  # Always run e2e-setup.ts to bootstrap TypeKro runtime
  echo "🔧 Setting up test environment (bootstrap TypeKro runtime)..."
  bun run scripts/e2e-setup.ts
  
  # Signal tests to skip any per-test cluster setup/teardown
  export SKIP_CLUSTER_SETUP=true
fi

# Run all integration tests with increased timeout
echo "🔍 DEBUG: SKIP_CLUSTER_SETUP is set to: ${SKIP_CLUSTER_SETUP}"
echo "🧪 Running Integration Tests..."
echo "🔍 DEBUG: About to run bun test command..."
echo "==============================="
bun test $(find test/integration -name '*.test.ts') --timeout 300000 # 5 minutes

echo "🔍 DEBUG: Test command completed!"
# Cleanup only if not in debug mode and we created the cluster
if [ "$DEBUG_MODE" != "true" ] && [ "${CREATE_CLUSTER:-false}" = "true" ]; then
  echo "🧹 Cleaning up integration test environment..."
  bun run scripts/e2e-cleanup.ts
  echo "✅ Integration test suite completed!"
elif [ "$DEBUG_MODE" = "true" ]; then
  echo "🔍 Debug mode enabled - cluster left running for inspection"
  if [ "${CREATE_CLUSTER:-false}" = "true" ]; then
    echo "   Use 'kubectl config use-context kind-typekro-e2e-test' to connect"
    echo "   Run 'bun run scripts/e2e-cleanup.ts' manually when done debugging"
  fi
  echo "   Cluster will NOT be automatically cleaned up on script exit"
else
  echo "✅ Integration test suite completed using existing cluster!"
fi

echo ""
echo "📊 Test Summary:"
echo "✅ YAML Generation: Comprehensive resource graph generation and validation"
if [ "$SKIP_CLUSTER_TESTS" != "true" ]; then
    echo "✅ E2E Cluster: Full deployment to Kubernetes with Kro"
else
    echo "⏭️  E2E Cluster: Skipped (install kubectl, kind, and Docker to enable)"
fi

echo ""
echo "📁 Generated files can be found in:"
echo "   - temp/"
echo ""
echo "🔍 To inspect generated YAML:"
echo "   cat packages/typekro/temp/*.yaml"