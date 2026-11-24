# Mechanical review gates

Fairquery t1507u / t1508u gate names, mapped onto this TypeScript/Node repo. Each gate is a hard failure (exit code ≠ 0). Nothing here calls a SaaS pull-request review bot.

Run all four:

```bash
npm run gates
```

| Gate name | Script / CI job | What it runs |
| --- | --- | --- |
| CCP Checker | `ccp-checker` | Semgrep (Cppcheck class) on `src/`. Local rules in `semgrep/cppcheck.yml`. Findings fail the process. |
| clang static analysis | `clang-static` | `tsc --noEmit` with the repo tsconfig (`strict` from `@apify/tsconfig`) and `eslint src --max-warnings 0`. |
| sanitizers | `sanitizers` | `npm test` (Vitest) and `npm audit --audit-level=high`. |
| unused-symbol / dead-export | `unused-symbol` | `knip` (pinned). Unused files, dependencies, and exports fail the process. |

CI is `.github/workflows/mechanical-gates.yml`. Pull requests and pushes to `main` / `master` run one job per gate. The existing `.github/workflows/test.yaml` build and MCP package checks stay as they are.

## CCP Checker = Semgrep

Cppcheck's class of check is a static defect scan that fails when it reports a finding. The JavaScript/TypeScript stand-in is Semgrep, not a C++ binary.

The OSS Semgrep CLI only ships a thin slice of `p/typescript` unless you log in to Semgrep App. This repo does not do that. `semgrep/cppcheck.yml` is the rule pack: dynamic code execution, `child_process`, TLS verification turned off, prototype pollution, `debugger`, `new Buffer()`, DOM HTML sinks, and identical if/else branches. Severity is `ERROR`, and the scan uses `--error`, so a match fails the gate.

Install the pinned CLI (the workflow does this before `ccp-checker`):

```bash
python -m pip install -r scripts/requirements-gates.txt
```

`semgrep==1.140.0` depends on Python package `mcp==1.16.0`. That release imports `eval_type_backport`, which pydantic 2.14.x removed, so the requirements file also pins `pydantic==2.11.9` (still inside mcp's `>=2.11,<3` range). Metrics are off (`--metrics=off`).

## clang static analysis = tsc + eslint

`clang-static` is `tsc --noEmit && eslint src --max-warnings 0`.

`tsconfig.json` extends `@apify/tsconfig`, which sets `strict`, `noImplicitReturns`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`. This package sets `noUnusedLocals` to false so unused-symbol ownership stays with knip.

ESLint is already type-aware. `eslint.config.mjs` points the TypeScript parser at `tsconfig.json`, and `@apify/eslint-config` turns on the type-checked rules `no-floating-promises`, `await-thenable`, `no-misused-promises`, `promise-function-async`, `no-for-in-array`, `no-implied-eval`, and `prefer-includes`. `typescript-eslint` `recommendedTypeChecked` is not enabled: it would force a large source edit for rules that are not needed to typecheck the Actor.

One lint-shaped edit was required for this gate to pass. `unescapeJsonSlice` in `src/json-array.ts` restores a NUL sentinel with `split('\u0000').join('\\')` instead of a regular expression that contained a control character (`no-control-regex`). The sentinel and the replacement are unchanged. The repo `lib` is `DOM` only, which does not include `String.replaceAll`.

## sanitizers = tests + npm audit

`sanitizers` runs the package test entry (`vitest run`) and then `npm audit --audit-level=high`. High and critical advisories fail. Moderate advisories do not.

`overrides.follow-redirects` is pinned to `1.16.2` so the high advisory in `axios` → `follow-redirects` 1.16.1 (credentials following a cross-realm redirect) is not installable. There is no native addon in this repo. If one is added later, this gate should also build it with ASan and UBSan.

## unused-symbol = knip

`unused-symbol` runs `node scripts/check-mcp-surface.mjs` and then `knip`. Knip is configured in `knip.json` and is not in warn-only mode.

Knip's project is `src/`, `test/`, and `scripts/**/*.ts`. It ignores `mcp/**` for two reasons:

- `mcp/src/shared/*` is generated from `src/` by `mcp/scripts/sync-shared.mjs`. `npm --prefix mcp test` already fails if the copy is stale. Scanning both copies double-counts every export.
- `mcp/src/common.ts` keeps the parked Actor proxy (`runActor`) and the token normalizer. `mcp/scripts/test-token.mjs` loads `normalizeApifyToken` from `dist/common.js` with a dynamic import knip does not follow. Deleting those exports would change the published 1.1.19 helper module.

Symbols that `mcp/src/index.ts` imports from `./shared/` are real uses of the canonical `src/` modules. `scripts/mcp-public-surface.ts` repeats that import list so knip sees it, and `scripts/check-mcp-surface.mjs` exits 1 if the two lists differ. The surface module is not on the Actor or MCP runtime path.

Dead exports that nothing imported were either deleted (`hasAnyFilter`, `OutputRow`) or left in place without `export` when the file still uses them. Call behavior of the free Jobs tools and the Actor is unchanged.
