# Deployment Setup — Multi-Account (dev / stg / prd)

This is a one-time, per-environment setup guide. Once complete, all future deploys happen automatically through GitHub Actions — nobody runs `cdk deploy` from a laptop, and no AWS access keys are ever stored in GitHub.

**Architecture**: each environment (`dev`, `stg`, `prd`) lives in its own separate AWS account. Branch → environment: `development`→`dev`, `staging`→`stg`, `main`→`prd`.

```
                    GitHub repo: cesschneider/aws-bedrock-agent-core
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     GitHub Environment:      GitHub Environment:      GitHub Environment:
          "dev"                     "stg"                     "prd"
     (auto-deploy on           (auto-deploy on           (auto-deploy on
      merge to development)     merge to staging)          merge to main;
                                                         gated by reviewers)
              │                        │                        │
              ▼                        ▼                        ▼
      AWS Account: DEV           AWS Account: STG         AWS Account: PRD
      (OIDC role +               (OIDC role +               (OIDC role +
       cdk bootstrap)             cdk bootstrap)             cdk bootstrap)
```
AWS profiles: `eworkslabs-dev`, `eworkslabs-stg`, `eworkslabs-prd`.

Repeat **Part 1** three times — once per AWS account. Do **Part 2** once in GitHub.

---

## Prerequisites

- Three AWS accounts, one per environment. If you don't have them yet, create them via [AWS Organizations](https://console.aws.amazon.com/organizations) (recommended — keeps billing consolidated while accounts stay isolated) or as three standalone accounts.
- AWS CLI installed locally, and (temporarily, for this one-time setup only) admin-level credentials for each account — this is the normal, expected use of elevated access for initial account bootstrapping. After this setup, nothing needs elevated/root credentials again; all subsequent deploys use the narrowly-scoped OIDC role.
- `gh` CLI authenticated to this repo (`gh auth status`), with admin access to configure Environments.

---

## Part 1 — Per AWS account (repeat for dev, stg, prd)

Run every command below **once per account**, using the AWS profile: `eworkslabs-dev`, `eworkslabs-stg`, or `eworkslabs-prd`.

### 1.1 Confirm you're targeting the right account

```bash
aws sts get-caller-identity --profile eworkslabs-<env-slug>
```

Confirm the `Account` field matches the AWS account you intend for this environment before proceeding — the next steps create real resources.

### 1.2 Run `cdk bootstrap`

This is AWS CDK's own one-time setup — it creates the `cdk-hnb659fds-*` roles and an S3 staging bucket that all future `cdk deploy` calls use.

```bash
cd aws-bedrock-agent-core
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile eworkslabs-<env-slug>
```

Replace `ACCOUNT_ID` with the account ID from step 1.1, and the region if you're not using `us-east-1`.

### 1.3 Deploy the GitHub OIDC bootstrap stack

This registers GitHub Actions as a trusted OIDC identity provider in this account and creates a deploy role scoped to this repo's `main`, `development`, and `staging` branches.

```bash
npm run cdk:bootstrap-oidc -- deploy --profile eworkslabs-<env-slug>
```

Confirm the IAM changes when prompted (creating an OIDC provider and an IAM role).

### 1.4 Capture the deploy role ARN

The stack output includes `DeployRoleArn`. Copy it — you'll need it in Part 2.

```bash
aws cloudformation describe-stacks \
  --stack-name GitHubOidcBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text \
  --profile eworkslabs-<env-slug>
```

It looks like: `arn:aws:iam::111122223333:role/github-actions-rag-knowledge-agent-deploy`

### 1.5 Repeat

Repeat steps 1.1–1.4 for the other two accounts. You should end up with three role ARNs, one per account.

---

## Part 2 — GitHub configuration (once)

### 2.1 Create three GitHub Environments

Repo → **Settings → Environments → New environment**. Create:
- `dev`
- `stg`
- `prd`

### 2.2 Add variables to each environment

For each environment, add these repository/environment **variables** (Settings → Environments → *environment name* → Environment variables — not secrets, since a role ARN isn't a secret and secrets are harder to audit/reference):

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The role ARN captured in step 1.4 for **that account** |
| `AWS_REGION` | The region you bootstrapped, e.g. `us-east-1` (optional — workflow defaults to `us-east-1` if unset) |

Each environment gets its **own** role ARN pointing at its **own** AWS account — this is what makes the isolation real, not just naming.

### 2.3 Add protection rules to prd

Still on the environment settings page, for **`prd`** only:

- Enable **Required reviewers** and add yourself (and/or teammates) — this makes production deploys pause for manual approval before running.
- Optionally add protection rules to `stg` if you want a manual approval gate before staging.
- Leave **`dev`** with no protection rules — auto-deploy on every merge to `development`.

Optionally, restrict deploy branches for `prd` (Selected branches → `main`).

### 2.4 Verify

Push any small change to `development` and confirm the `dev` deploy succeeds:

```bash
gh run list --workflow=deploy.yml --limit 5
gh run watch
```

For `stg`, push to the `staging` branch. For `prd`, push to `main`:

```bash
gh workflow run deploy.yml -f environment=prd
```

Required reviewers get a notification to approve before `prd` runs.

---

## What happens after this is done

- **Local development**: still just `git checkout -b feature/...`, edit, `npm test`, commit, push, open a PR. Nobody runs `cdk deploy` from a laptop.
- **On PR**: `.github/workflows/ci.yml` runs typecheck/lint/test/synth. No deploy happens from a PR branch.
- **On merge to `development`**: auto-deploys to the `dev` AWS account.
- **On merge to `staging`**: auto-deploys to the `stg` AWS account.
- **On merge to `main`**: deploys to `prd` (gated by required reviewers, per 2.3).
- **Manual promotion**: `gh workflow run deploy.yml -f environment=<env-slug>`.

## Troubleshooting

- **"Not authorized to perform sts:AssumeRoleWithWebIdentity"** — the OIDC trust policy's `sub` condition doesn't match. Confirm you're pushing to `main`, `development`, or `staging` (the bootstrap stack's `allowedRefs` trusts all three).
- **"User is not authorized to perform: sts:AssumeRole on resource: cdk-hnb659fds-deploy-role-..."** — `cdk bootstrap` (step 1.2) wasn't run in that account/region, or was run with a different qualifier than the default `hnb659fds`.
- **Deploy workflow shows red X immediately with no AWS error** — `AWS_DEPLOY_ROLE_ARN` variable isn't set for that GitHub Environment (Part 2.2 not done yet for that environment).

