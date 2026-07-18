# RAG Knowledge Agent

CDK (TypeScript) infra + Lambda backend for the internal RAG knowledge agent (see `specs/rag-knowledge-agent-spec.md`). Frontend lives in a separate repo.

## Testing

- `npm run typecheck` — TypeScript type-check, no emit
- `npm run lint` — ESLint (flat config)
- `npm test` — Jest unit tests (`test/**/*.test.ts`, `lambda/**/*.test.ts`)
- `npx cdk synth` — synthesize CloudFormation without deploying

All four run in CI (`.github/workflows/ci.yml`) on every PR to `main` and must pass before merge.

## Deployment

Deploys happen exclusively via GitHub Actions (`.github/workflows/deploy.yml`) — `cdk deploy` should never be run from a local machine against a real environment. Each environment (dev/staging/prod) is a separate AWS account with its own OIDC deploy role; no AWS access keys are stored in GitHub. See `docs/deployment-setup.md` for the one-time per-account setup and `lib/bootstrap/github-oidc-stack.ts` for what it deploys.

AWS credentials used for local `cdk synth` / testing must be a scoped IAM user/role, never root.

# gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
