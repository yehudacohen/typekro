#!/bin/bash

set -euo pipefail

# Check if debug mode is enabled
DEBUG_MODE=${DEBUG_MODE:-false}

# Initialise variables referenced later so `set -u` doesn't blow up
SKIP_CLUSTER_TESTS=${SKIP_CLUSTER_TESTS:-false}
SKIP_CLUSTER_SETUP=${SKIP_CLUSTER_SETUP:-false}
REQUIRE_CLUSTER_TESTS=${REQUIRE_CLUSTER_TESTS:-false}
CREATE_CLUSTER=false

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

if [ "$SKIP_CLUSTER_TESTS" = "true" ] && [ "$REQUIRE_CLUSTER_TESTS" = "true" ]; then
    echo "❌ Cluster integration tests are required, but prerequisites are missing."
    echo "   Install kubectl/kind and start Docker, or unset REQUIRE_CLUSTER_TESTS."
    exit 1
fi

if [ "$SKIP_CLUSTER_TESTS" = "true" ]; then
    echo "⏭️  Skipping cluster integration tests because prerequisites are missing."
    echo "   Set REQUIRE_CLUSTER_TESTS=true to fail instead of skipping."
    exit 0
fi

echo ""

cleanup() {
  echo ""
  echo "🧹 Cleaning up integration test environment..."
  # Only cleanup if we created the cluster (not using existing cluster)
  if [ "$SKIP_CLUSTER_TESTS" != "true" ] && [ "$DEBUG_MODE" != "true" ] && [ "$CREATE_CLUSTER" = "true" ]; then
    bun run scripts/e2e-cleanup.ts || true
  fi
}
trap cleanup EXIT

# Setup cluster for integration tests
if [ "$SKIP_CLUSTER_TESTS" != "true" ]; then
  # Check if we should create a new kind cluster
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
  # NOTE: We now use bun directly with our custom BunCompatibleHttpLibrary
  # which works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
  # by extracting TLS options from https.Agent and passing them directly to https.request
  NODE_ENV=test NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/e2e-setup.ts

  # NATS JetStream file storage requires a real RWO StorageClass. An explicit
  # class wins; otherwise use only the cluster's annotated default. Never
  # mutate a caller-owned cluster by installing storage infrastructure.
  if [ -n "${TYPEKRO_NATS_STORAGE_CLASS:-}" ]; then
    if ! kubectl get storageclass "$TYPEKRO_NATS_STORAGE_CLASS" > /dev/null 2>&1; then
      echo "❌ TYPEKRO_NATS_STORAGE_CLASS names a missing StorageClass: $TYPEKRO_NATS_STORAGE_CLASS"
      exit 1
    fi
  else
    TYPEKRO_NATS_STORAGE_CLASS=$(kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -n 1 || true)
    if [ -z "$TYPEKRO_NATS_STORAGE_CLASS" ]; then
      TYPEKRO_NATS_STORAGE_CLASS=$(kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.beta\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -n 1 || true)
    fi
  fi
  if [ -z "$TYPEKRO_NATS_STORAGE_CLASS" ] && [ "$CREATE_CLUSTER" = "true" ]; then
    echo "🔧 Installing local-path StorageClass in the harness-created cluster..."
    kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
    kubectl rollout status deployment/local-path-provisioner -n local-path-storage --timeout=180s
    TYPEKRO_NATS_STORAGE_CLASS=local-path
  elif [ -z "$TYPEKRO_NATS_STORAGE_CLASS" ]; then
    echo "❌ Existing cluster has no default StorageClass for JetStream integration."
    echo "   Set TYPEKRO_NATS_STORAGE_CLASS to an existing RWO-capable StorageClass."
    exit 1
  fi
  export TYPEKRO_NATS_STORAGE_CLASS
  echo "   JetStream StorageClass: $TYPEKRO_NATS_STORAGE_CLASS"

  # Signal tests to skip any per-test cluster setup/teardown
  SKIP_CLUSTER_SETUP=true
  export SKIP_CLUSTER_SETUP
fi

# Run all integration tests with increased timeout
echo "🧪 Running Integration Tests..."
echo "==============================="
# NOTE: We still use bun test but with NODE_TLS_REJECT_UNAUTHORIZED=0
# The client cert auth issue with Bun is being tracked. For now, this allows
# TLS to work, and we rely on the cluster's default service account for auth.
NODE_TLS_REJECT_UNAUTHORIZED=0 bun test $(find test/integration -name '*.test.ts') --timeout 1200000 # 20 minutes

echo ""

# Cleanup only if not in debug mode and we created the cluster
if [ "$SKIP_CLUSTER_TESTS" != "true" ]; then
  if [ "$DEBUG_MODE" != "true" ] && [ "$CREATE_CLUSTER" = "true" ]; then
    echo "🧹 Cleaning up integration test environment..."
    bun run scripts/e2e-cleanup.ts
    echo "✅ Integration test suite completed!"
  elif [ "$DEBUG_MODE" = "true" ]; then
    echo "🔍 Debug mode enabled - cluster left running for inspection"
    if [ "$CREATE_CLUSTER" = "true" ]; then
      echo "   Use 'kubectl config use-context kind-typekro-e2e-test' to connect"
      echo "   Run 'bun run scripts/e2e-cleanup.ts' manually when done debugging"
    fi
    echo "   Cluster will NOT be automatically cleaned up on script exit"
  else
    echo "✅ Integration test suite completed using existing cluster!"
  fi
fi

echo ""
echo "📊 Test Summary:"
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
