# Build and Test Tooling Requirements

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
bun test

# Run tests in watch mode
bun vitest --watch

# Run specific test file
bun vitest path/to/test.ts

# Run tests with coverage
bun vitest --coverage

# Run tests with UI
bun vitest --ui
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

### CI/CD Integration

**GitHub Actions Example**:
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

### Resources

- [Bun Documentation](https://bun.sh/docs)
- [Bun Installation Guide](https://bun.sh/docs/installation)
- [Migrating from npm/yarn to Bun](https://bun.sh/docs/cli/install)