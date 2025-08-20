# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of TypeKro seriously. If you believe you have found a security vulnerability, please report it to us as described below.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **security@typekro.run**

You should receive a response within 48 hours. If the issue is confirmed, we will release a patch as soon as possible depending on complexity.

## What to Include

Please include the following information in your report:

- Type of issue (e.g. buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Security Considerations for TypeKro

When using TypeKro, please be aware of these security considerations:

### 1. **Cluster Access**
- TypeKro requires Kubernetes cluster access for direct deployment mode
- Ensure proper RBAC policies are in place for the service account used
- Use least-privilege principles for cluster access

### 2. **Secret Management**
- Never commit secrets, tokens, or credentials to your TypeKro resource definitions
- Use Kubernetes Secrets or external secret management systems
- Be careful with CEL expressions that might expose sensitive data

### 3. **Container Images**
- Always use specific image tags, not `latest`
- Scan container images for vulnerabilities
- Use trusted image registries

### 4. **Network Policies**
- Implement Kubernetes Network Policies to restrict traffic
- Use TypeKro's `networkPolicy()` factory function to define network security

### 5. **Resource Limits**
- Always set resource requests and limits
- Prevent resource exhaustion attacks

### 6. **Supply Chain Security**
- Regularly update TypeKro and its dependencies
- Review dependency security advisories
- Use Dependabot for automated security updates

## Vulnerability Disclosure Timeline

1. **Day 0**: Vulnerability reported via email
2. **Day 1-2**: Initial response and triage
3. **Day 3-7**: Investigation and fix development
4. **Day 7-14**: Patch release and security advisory
5. **Day 14+**: Public disclosure after users have time to update

## Security Updates

Security updates will be announced:

- In the GitHub Security Advisories for this project
- In release notes with clear marking of security fixes
- On our Discord community server: https://discord.gg/kKNSDDjW
- Via npm advisory if applicable

## Scope

This security policy applies to the following:

- TypeKro core library (`typekro` npm package)
- Official examples and documentation
- Build and deployment infrastructure

This policy does not cover:

- User-generated resource definitions
- Third-party dependencies (please report to their respective maintainers)
- Infrastructure deployed using TypeKro (responsibility of the user)

## Comments on This Policy

If you have suggestions on how this process could be improved, please submit a pull request or create an issue to discuss.