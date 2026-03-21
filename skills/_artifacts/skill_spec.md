# devtree - Skill Spec

Devtree is a single-package TypeScript library and CLI for running the same Vite+ app in multiple git worktrees without local-development collisions. It does that by generating worktree-scoped public URLs, managed env values, scoped dependency names, and cleanup support for orphaned local resources.

## Domains

| Domain | Description | Skills |
| ------ | ----------- | ------ |
| configuring isolated worktrees | Setting up repo-level configuration so each worktree gets isolated URLs, env values, and dependency names. | set-up-devtree |
| operating isolated development runtime | Running, checking, inspecting, and cleaning up a worktree-scoped dev environment once configuration exists. | run-and-operate-devtree |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| ----- | ---- | ------ | -------------- | ------------- |
| set-up-devtree | core | configuring isolated worktrees | `define_devtree_config`, `devtree.config.ts`, env entries, dependencies, hooks, Vite integration, `doctor --fix`, `setup` | 4 |
| run-and-operate-devtree | core | operating isolated development runtime | `dev`, `info`, `env write`, `env show`, `deps start|stop|logs`, `gc`, `doctor` | 4 |

## Failure Mode Inventory

### set up devtree (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | ------- | -------- | ------ | ------------ |
| 1 | Hard-code shared URLs and ports | CRITICAL | `README.md` | - |
| 2 | Store manual values inside managed block | HIGH | `src/env-file.ts` | - |
| 3 | Force shared dependency project names | HIGH | `src/cli.ts:156` | - |
| 4 | Enable varlock without integration prerequisites | HIGH | `src/cli.ts:338`, `src/vite.ts:45` | - |

### run and operate devtree (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | ------- | -------- | ------ | ------------ |
| 1 | Start Vite directly instead of devtree | CRITICAL | `README.md`, `src/command-builder.ts` | `set-up-devtree` |
| 2 | Disable portless and expect APP_URL to exist | HIGH | `src/cli.ts:499` | - |
| 3 | Skip setup when dependencies or hooks matter | HIGH | `README.md`, `src/cli.ts:448` | - |
| 4 | Assume gc removes unknown docker projects | MEDIUM | `src/gc.ts:356` | - |

## Tensions

| Tension | Skills | Agent implication |
| ------- | ------ | ----------------- |
| simple setup versus explicit override freedom | `set-up-devtree` ↔ `run-and-operate-devtree` | Agents may hard-code URLs, ports, or names instead of preserving devtree-managed isolation. |
| portless compatibility versus public URL correctness | `set-up-devtree` ↔ `run-and-operate-devtree` | Agents may disable portless for convenience and forget the explicit callback URL fallback. |

## Cross-References

| From | To | Reason |
| ---- | -- | ------ |
| `set-up-devtree` | `run-and-operate-devtree` | Setup choices control what runtime diagnostics and cleanup patterns are needed later. |
| `run-and-operate-devtree` | `set-up-devtree` | Runtime failures usually trace back to `devtree.config.ts` decisions. |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| ----- | ---------- | -------------------- |
| `set-up-devtree` | - | - |
| `run-and-operate-devtree` | - | - |

## Recommended Skill File Structure

- **Core skills:** `set-up-devtree`, `run-and-operate-devtree`
- **Framework skills:** none
- **Lifecycle skills:** none
- **Composition skills:** none; companion tools should be handled through devtree setup rather than separate integration skills
- **Reference files:** none yet

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| `vite-plus` | dev server entrypoint and plugin registration | no |
| `portless` | public URL generation and proxied dev server runtime | no |
| `varlock` | optional env provider, schema, and Vite integration | no |
