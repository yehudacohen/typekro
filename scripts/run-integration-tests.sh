#!/bin/bash

set -e

echo "🚀 TypeKro Integration Test Suite"
echo "=================================="

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

# Run YAML generation tests (these don't require a cluster)
echo "📄 Running YAML Generation Tests..."
echo "-----------------------------------"
bun test test/integration/yaml-generation.test.ts

echo ""

# Run E2E cluster tests if dependencies are available
if [ "$SKIP_CLUSTER_TESTS" != "true" ]; then
    echo "🎯 Running End-to-End Cluster Tests..."
    echo "-------------------------------------"
    echo "⚠️  This will create a temporary kind cluster and may take several minutes"
    read -p "Continue? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        bun test test/integration/e2e-cluster.test.ts
    else
        echo "⏭️  Skipping E2E cluster tests"
    fi
else
    echo "⏭️  Skipping E2E cluster tests (missing dependencies)"
fi

echo ""
echo "🎉 Integration tests completed!"
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
echo "   - packages/typekro/temp/"
echo ""
echo "🔍 To inspect generated YAML:"
echo "   cat packages/typekro/temp/*.yaml"