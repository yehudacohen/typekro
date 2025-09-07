# Tooling Requirements

## Overview

This document outlines the build tools, package management, and development environment requirements for TypeKro. It covers everything from package manager selection to integration testing cluster setup.

These tooling requirements support the [Development Standards](development-standards.md) and enable the comprehensive [Testing Guidelines](testing-guidelines.md). For understanding the system architecture these tools support, see the [Architecture Guide](architecture-guide.md).

## Package Manager and Runtime

### Use Bun Instead of npm/yarn

**Requirement**: This project must use `bun` as the package manager and JavaScript runtime instead of `npm`, `yarn`, or `pnpm`.

**Rationale**:
- **Performance**: Bun is significantly faster for package installation, builds, and test execution
- **Built-in Test Runner**: Bun includes a fast, built-in test runner eliminating the need for additional test frameworks
- **TypeScript Support**: Native TypeScript support without additional compilation steps
- **Compatibility**: Drop-in replacement for npm with better performance characteristics
- **Monorepo Support**: Excellent workspace support for our monorepo structure

### Commands to Use

**Package Management**:
```bash
# Install dependencies
bun install

# Add dependencies
bun add <package>
bun add -d <dev-package>

# Remove dependencies
bun remove <package>
```

**Build and Development**:
```bash
# Run build scripts
bun run build

# Start development server
bun run dev

# Run any package.json script
bun run <script-name>
```

**Testing**:
```bash
# Run all tests (when using vitest)
bun vitest

# Run all tests (when using bun's built-in test runner)
bun run test:all

# Run unit tests:
bun run test

# Run integration tests
bun run test:integration

# Run integration tests leaving the kind cluster around after for interactive debugging
bun run test:integration:debug
```

### Project Configuration

**package.json Scripts**:
```json
{
  "scripts": {
    "build": "bun run build:packages && bun run build:apps",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "dev": "bun run dev:packages && bun run dev:apps",
    "install:clean": "rm -rf node_modules && bun install"
  }
}
```

**Workspace Configuration** (for monorepos):
```json
{
  "workspaces": [
    "packages/*",
    "apps/*"
  ]
}
```

### Installing Bun

**Initial Installation** (using npm as bootstrap):
```bash
# Install bun globally using npm
npm install -g bun

# Verify installation
bun --version
```

**Alternative Installation Methods**:
```bash
# Using curl (macOS/Linux)
curl -fsSL https://bun.sh/install | bash

# Using Homebrew (macOS)
brew install bun
```

### Migration from npm/yarn

When working on existing projects:

1. **Install bun** (if not already installed):
   ```bash
   npm install -g bun
   ```

2. **Remove old lock files**:
   ```bash
   rm package-lock.json yarn.lock pnpm-lock.yaml
   ```

3. **Install dependencies with bun**:
   ```bash
   bun install
   ```

4. **Update CI/CD pipelines** to use bun instead of npm/yarn

5. **Update documentation** to reference bun commands

### Exceptions

The only acceptable exceptions to using bun are:

1. **Legacy systems** where migration would be prohibitively expensive
2. **Third-party tools** that explicitly require npm/yarn and don't work with bun
3. **Deployment environments** where bun is not available (must be documented and approved)

### Enforcement

- All new projects MUST use bun from the start
- Existing projects SHOULD migrate to bun during their next major update cycle
- Code reviews SHOULD flag any use of npm/yarn commands in documentation or scripts
- CI/CD pipelines MUST use bun for all JavaScript/TypeScript projects

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v1
  with:
    bun-version: latest

- name: Install dependencies
  run: bun install

- name: Run tests
  run: bun test

- name: Build
  run: bun run build
```

### Best Practices for CI/CD

- Always pin bun version in CI/CD for reproducible builds
- Cache node_modules directory for faster builds
- Run tests in parallel when possible
- Use bun's built-in test runner for optimal performance

## Development Environment Setup

### Required Tools

**Core Requirements**:
- **Bun**: Package manager and JavaScript runtime
- **kubectl**: Kubernetes command-line tool for cluster interaction
- **Docker**: Container runtime for local development
- **kind**: Kubernetes in Docker for local testing clusters

**Optional but Recommended**:
- **k9s**: Terminal-based Kubernetes dashboard
- **helm**: Package manager for Kubernetes
- **jq**: JSON processor for parsing kubectl output

### Environment Configuration

**Shell Configuration**:
Add these to your shell profile (`.bashrc`, `.zshrc`, etc.):

```bash
# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# kubectl completion (optional)
source <(kubectl completion bash)  # for bash
source <(kubectl completion zsh)   # for zsh
```

**IDE Configuration**:
- Install TypeScript language server
- Configure ESLint and Prettier extensions
- Set up Kubernetes YAML schema validation

## Integration Testing Infrastructure

### Cluster Setup

#### Automated Cluster Creation

**Use the e2e-setup script to create a test cluster:**

```bash
bun run scripts/e2e-setup.ts
```

This script will:
- Create a kind cluster named `typekro-e2e-test`
- Set up the `typekro-test` namespace
- Install necessary components (Kro controller, Flux, etc.)
- Configure kubectl context properly

#### Manual Cluster Requirements

If you have an existing cluster, ensure it has:
- Kro controller installed
- Flux controllers installed (for Helm integration tests)
- A `typekro-test` namespace
- Proper RBAC permissions

### Running Integration Tests

#### Test Execution Commands

**Single Test File**:
```bash
bun run test:integration -- test/integration/cilium/integration.test.ts
```

**All Integration Tests**:
```bash
bun run test:integration
```

**Debug Mode** (leaves cluster alive for debugging):
```bash
bun run test:integration:debug
```

#### Test Timeouts

Integration tests use reasonable timeouts:
- Resource creation: 60 seconds
- Readiness evaluation: 120 seconds
- Complete deployment: 300 seconds (5 minutes)

If tests consistently timeout, check cluster resources and network connectivity.

### Troubleshooting and Debugging

#### Cluster Health Checks

**Check cluster status:**
```bash
kubectl get nodes
kubectl get pods -A
```

**Check test namespace:**
```bash
kubectl get all -n typekro-test
```

**Check system controllers:**
```bash
# Kro controller
kubectl get pods -n kro-system
kubectl logs -n kro-system deployment/kro-controller-manager

# Flux controllers
kubectl get pods -n flux-system
kubectl logs -n flux-system deployment/source-controller
kubectl logs -n flux-system deployment/helm-controller
```

#### Resource Deployment Issues

**Check resource creation:**
```bash
kubectl get helmrepositories -A
kubectl get helmreleases -A
```

**Check resource status:**
```bash
kubectl describe helmrepository <name> -n <namespace>
kubectl describe helmrelease <name> -n <namespace>
```

**Check events:**
```bash
kubectl get events -n typekro-test --sort-by='.lastTimestamp'
```

#### Common Issues and Solutions

1. **Cluster Not Ready**: Ensure all system pods are running before starting tests
2. **Resource Conflicts**: Clean up resources between test runs to avoid conflicts
3. **Network Issues**: Check that the cluster can pull container images
4. **RBAC Problems**: Verify that the test service account has necessary permissions
5. **Controller Issues**: Ensure Kro and Flux controllers are healthy and responsive

### Cleanup and Maintenance

#### Cluster Cleanup

The e2e-setup script creates a persistent cluster for debugging. To clean up:

```bash
bun run scripts/e2e-cleanup.sh
```

#### Resource Cleanup

Always clean up test resources to prevent interference between test runs:

```bash
# Clean up all resources in test namespace
kubectl delete all --all -n typekro-test

# Or delete and recreate the namespace
kubectl delete namespace typekro-test
kubectl create namespace typekro-test
```

## Development Workflow Best Practices

### Local Development

1. **Use bun for all operations** - package management, builds, and tests
2. **Keep integration cluster running** between test runs for faster iteration
3. **Run unit tests frequently** during development
4. **Use integration tests for validation** before committing changes

These practices align with the [Development Standards](development-standards.md) philosophy of production-quality development from day one.

### Testing Strategy

1. **Always use the e2e-setup script** for consistent test environments
2. **Run integration tests in isolation** to avoid resource conflicts
3. **Check cluster state** before running tests if they're failing
4. **Use kubectl for debugging** when tests don't behave as expected
5. **Clean up resources** after tests complete to avoid state pollution

For detailed testing approaches and patterns, see the [Testing Guidelines](testing-guidelines.md).

### Performance Optimization

1. **Cache dependencies** in CI/CD pipelines
2. **Use bun's parallel execution** for faster test runs
3. **Keep test clusters warm** for faster integration test execution
4. **Monitor resource usage** to prevent cluster overload

## Resources and Documentation

### Bun Resources
- [Bun Documentation](https://bun.sh/docs)
- [Bun Installation Guide](https://bun.sh/docs/installation)
- [Migrating from npm/yarn to Bun](https://bun.sh/docs/cli/install)

### Kubernetes Resources
- [kubectl Documentation](https://kubernetes.io/docs/reference/kubectl/)
- [kind Documentation](https://kind.sigs.k8s.io/)
- [Kro Controller Documentation](https://github.com/Azure/kro)

### Development Tools
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [ESLint Configuration](https://eslint.org/docs/user-guide/configuring/)
- [Prettier Configuration](https://prettier.io/docs/en/configuration.html)