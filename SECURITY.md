# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to **security@compassdocs.io** —
do not open a public GitHub issue for a vulnerability.

Include steps to reproduce and any relevant details. We acknowledge reports
within **2 business days** and keep you updated through remediation. Please give
us reasonable time to release a fix before public disclosure — we will not
pursue good-faith researchers who follow this policy, and we're happy to credit
you in the release notes.

A machine-readable contact is published at
<https://compassdocs.io/.well-known/security.txt>.

## Supported versions

Security fixes ship in the latest release. Run a current version (see the
[changelog](CHANGELOG.md)) before reporting, and see the
[Security & Encryption guide](https://docs.compassdocs.io/self-hosting/security/)
for how CompassDocs protects credentials, sessions, and backups. (CompassDocs
Cloud customers can find hosted-operations details in the
[Trust Center](https://trust.compassdocs.io), available under NDA.)

## What the project already does

Dependency and image scanning run in CI (`npm audit`, Trivy for
vulnerabilities/secrets/misconfig) on every change, with Dependabot proposing
updates. Details of the app's built-in protections are in the security guide
linked above.
