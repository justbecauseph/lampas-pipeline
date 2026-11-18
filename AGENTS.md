# Agent Guidelines

Guidelines and rules for AI assistants working in this repository.

## Development Workflow

- **Define Scope & Acceptance Criteria**: Before starting substantial work, define the scope and acceptance criteria in `PROGRESS.md`. The base plan is in `PLAN.md` - both these files are deliberately gitignored.
- **Phased Implementation**: Execute implementation in distinct, structured phases.
- **Verification**: Run unit tests (`bun test`) and full build (`bun run build`) after every phase.
- **Progress Tracking**: Record all completed phases, architectural notes, and verification evidence in `PROGRESS.md`.
- **Commit & Push**: Commit and push to GitHub after every completed phase. Present commit range and url to review.
- **Stop for Review**: Stop development after every completed phase for human code review.
- Also update CHANGELOG.md for lampasctl scoped changes
- **Pack is a submodule**: `pack/` (mod and resource pack definitions, `pack.lock.json`, custom JARs) is a git submodule of the private `justbecauseph/lampas2-pack` repository. Pack changes such as `lampasctl add` or a version bump show in `git -C pack status`, `git -C pack diff` and `git -C pack log`; in this repository they show only as a modified `pack` pointer. Work on `main` inside `pack/` (`git submodule update` leaves a detached HEAD; run `git -C pack switch main`). Commit and push inside `pack/` first, then commit the `pack` pointer here. The generated `manifest/` stays gitignored.

## Reference Repositories

- C:\Users\markj\source\repos\lampas-pipeline
- C:\Users\markj\source\repos\lampas-launcher
- C:\Users\markj\source\repos\lampas2-portal

## Lampas knowledgebase (lampas-kb)

`.mcp.json` connects the `lampas-kb` MCP server at `https://kb.lampas.town/mcp`; it needs a token from https://kb.lampas.town/auth/token in the `LAMPAS_KB_TOKEN` environment variable ([kb README](https://github.com/justbecauseph/lampas-two-kb/blob/main/kb/README.md#mcp-server-lampas-kb)). Ask it before stating what is deployed, decided or designed for Lampas 2 outside this repository: take versions from its `status` tool, attribute discussion to the person who said it, and treat plans as intent.
