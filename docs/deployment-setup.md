# Deployment Setup — Multi-Account (dev / staging / prod)

This is a one-time, per-environment setup guide. Once complete, all future deploys happen automatically through GitHub Actions — nobody runs `cdk deploy` from a laptop, and no AWS access keys are ever stored in GitHub.

**Architecture**: each environment (`dev`, `staging`, `prod`) lives in its own separate AWS account, for logical and security isolation. A bug, a runaway cost, or a compromised credential in `dev` cannot touch `staging` or `prod` resources — there is no shared account boundary to cross.

```
                    GitHub repo: cesschneider/aws-bedrock-agent-core
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     GitHub Environment:      GitHub Environment:      GitHub Environment:
          "dev"                    "staging"                  "prod"
     (auto-deploy on           (workflow_dispatch,        (workflow_dispatch,
      merge to main)            required reviewer)          required reviewer)
              │                        │                        │
              ▼                        ▼                        ▼
      AWS Account: DEV           AWS Account: STAGING      AWS Account: PROD
      (OIDC role +               (OIDC role +               (OIDC role +
       cdk bootstrap)             cdk bootstrap)             cdk bootstrap)
```

Repeat **Part 1** three times — once per AWS account. Do **Part 2** once in GitHub.

---

## Prerequisites

- Three AWS accounts, one per environment. If you don't have them yet, create them via [AWS Organizations](https://console.aws.amazon.com/organizations) (recommended — keeps billing consolidated while accounts stay isolated) or as three standalone accounts.
- AWS CLI installed locally, and (temporarily, for this one-time setup only) admin-level credentials for each account — this is the normal, expected use of elevated access for initial account bootstrapping. After this setup, nothing needs elevated/root credentials again; all subsequent deploys use the narrowly-scoped OIDC role.
- `gh` CLI authenticated to this repo (`gh auth status`), with admin access to configure Environments.

---

## Part 1 — Per AWS account (repeat for dev, staging, prod)

Run every command below **once per account**, using that account's credentials (`aws configure --profile <env>-account` or equivalent, then `--profile <env>-account` on each command, or `AWS_PROFILE=<env>-account`).

### 1.1 Confirm you're targeting the right account

```bash
aws sts get-caller-identity --profile <env>-account
```

Confirm the `Account` field matches the AWS account you intend for this environment before proceeding — the next steps create real resources.

### 1.2 Run `cdk bootstrap`

This is AWS CDK's own one-time setup — it creates the `cdk-hnb659fds-*` roles and an S3 staging bucket that all future `cdk deploy` calls use.

```bash
cd aws-bedrock-agent-core
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile <env>-account
```

Replace `ACCOUNT_ID` with the account ID from step 1.1, and the region if you're not using `us-east-1`.

### 1.3 Deploy the GitHub OIDC bootstrap stack

This registers GitHub Actions as a trusted OIDC identity provider in this account and creates a deploy role scoped to this repo's `main` branch.

```bash
npm run cdk:bootstrap-oidc -- deploy --profile <env>-account
```

Confirm the IAM changes when prompted (creating an OIDC provider and an IAM role).

### 1.4 Capture the deploy role ARN

The stack output includes `DeployRoleArn`. Copy it — you'll need it in Part 2.

```bash
aws cloudformation describe-stacks \
  --stack-name GitHubOidcBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text \
  --profile <env>-account
```

It looks like: `arn:aws:iam::111122223333:role/github-actions-rag-knowledge-agent-deploy`

### 1.5 Repeat

Repeat steps 1.1–1.4 for the other two accounts. You should end up with three role ARNs, one per account.

---

## Part 2 — GitHub configuration (once)

### 2.1 Create three GitHub Environments

Repo → **Settings → Environments → New environment**. Create:
- `dev`
- `staging`
- `prod`

### 2.2 Add variables to each environment

For each environment, add these repository/environment **variables** (Settings → Environments → *environment name* → Environment variables — not secrets, since a role ARN isn't a secret and secrets are harder to audit/reference):

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The role ARN captured in step 1.4 for **that account** |
| `AWS_REGION` | The region you bootstrapped, e.g. `us-east-1` (optional — workflow defaults to `us-east-1` if unset) |

Each environment gets its **own** role ARN pointing at its **own** AWS account — this is what makes the isolation real, not just naming.

### 2.3 Add protection rules to staging and prod

Still on the environment settings page, for **`staging`** and **`prod`** only:

- Enable **Required reviewers** and add yourself (and/or teammates) — this makes `workflow_dispatch` deploys to these environments pause for manual approval before running.
- Leave **`dev`** with no protection rules — it deploys automatically on every merge to `main`, by design (it's the disposable, fast-feedback environment).

Optionally, also restrict which branches can deploy to `staging`/`prod` (Deployment branches and tags → Selected branches → `main`).

### 2.4 Verify

Push any small change to `main` (or re-run the failed "Deploy" workflow run from earlier) and confirm the `dev` deploy succeeds:

```bash
gh run list --workflow=deploy.yml --limit 5
gh run watch
```

For `staging`/`prod`, trigger manually:

```bash
gh workflow run deploy.yml -f environment=staging
```

You (or whoever you added as required reviewer) will get a notification to approve the run before it proceeds.

---

## What happens after this is done

- **Local development**: still just `git checkout -b feature/...`, edit, `npm test`, commit, push, open a PR. Nobody runs `cdk deploy` from a laptop.
- **On PR**: `.github/workflows/ci.yml` runs typecheck/lint/test/synth. No deploy happens from a PR branch.
- **On merge to `main`**: `.github/workflows/deploy.yml` automatically deploys to the `dev` AWS account.
- **Promoting to staging/prod**: manually trigger `deploy.yml` via `workflow_dispatch` (GitHub UI: Actions → Deploy → Run workflow → choose environment, or `gh workflow run deploy.yml -f environment=staging`). Requires the reviewer approval configured in 2.3.

## Troubleshooting

- **"Not authorized to perform sts:AssumeRoleWithWebIdentity"** — the OIDC trust policy's `sub` condition doesn't match. Confirm you're pushing to `main` (the bootstrap stack's `allowedRefs` only trusts `repo:cesschneider/aws-bedrock-agent-core:ref:refs/heads/main`).
- **"User is not authorized to perform: sts:AssumeRole on resource: cdk-hnb659fds-deploy-role-..."** — `cdk bootstrap` (step 1.2) wasn't run in that account/region, or was run with a different qualifier than the default `hnb659fds`.
- **Deploy workflow shows red X immediately with no AWS error** — `AWS_DEPLOY_ROLE_ARN` variable isn't set for that GitHub Environment (Part 2.2 not done yet for that environment).
