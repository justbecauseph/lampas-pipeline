# Agent Guidelines

Guidelines and rules for AI assistants working in this repository.

## Development Workflow

- **Define Scope & Acceptance Criteria**: Before starting substantial work, define the scope and acceptance criteria in `PROGRESS.md`. The base plan is in `PLAN.md` - both these files are deliberately gitignored.
- **Phased Implementation**: Execute implementation in distinct, structured phases.
- **Verification**: Run unit tests (`bun test`) and full build (`bun run build`) after every phase.
- **Progress Tracking**: Record all completed phases, architectural notes, and verification evidence in `PROGRESS.md`.
- **Commit & Push**: Commit and push to GitHub after every completed phase. Present commit range and url to review.
- **Stop for Review**: Stop development after every completed phase for human code review.

## Reference Repositories

- C:\Users\markj\source\repos\lampas-pipeline
- C:\Users\markj\source\repos\lampas-launcher
- C:\Users\markj\source\repos\lampas2-portal