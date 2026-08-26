# lampasctl Changelog

All notable changes to the `lampasctl` command-line distribution tool are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-26

### Added
- Multi-platform standalone executable distribution for Linux (x64 baseline, ARM64, musl), Windows (x64 baseline, ARM64), and macOS (x64, ARM64).
- Dedicated version commands (`lampasctl --version`, `lampasctl version`, `lampasctl -v`).
- Server resource-pack separation architecture with native CAS discovery and server-only deployment.
- Dual-target manifest generation (`localhost:3000` and `https://dev.lampas.town`).
- Post-mutation file integrity and size verification across client and server sync operations.
- Deterministic pack resolving, mod additions (`lampasctl add`), removals (`lampasctl remove`), and upstream update checking (`lampasctl check-updates`).
- Full SHA-256 integrity checks and `.lampas/installation.json` state tracking.
