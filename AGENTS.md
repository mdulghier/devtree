# AGENTS.md instructions

## Rules

- Solve problems with simple, maintainable, production-friendly solutions.
- Write low-complexity code that is easy to read, debug, and modify.
- Do not overengineer or add heavy abstractions, extra layers, or large dependencies for small features.
- Avoid cleverness unless it clearly improves the result.
- Do not leave dead code around after refactoring.
- Use kebab-case for filenames.
- Use snake_case for variables.
- Do not use barrel files unless explicitly instructed.

## Publishing

For stable or preview releases of this repository, read [.agents/skills/devtree-publish/SKILL.md](.agents/skills/devtree-publish/SKILL.md). Use `pnpm release` or `pnpm release:preview`; all npm publishing must run through GitHub Actions.
