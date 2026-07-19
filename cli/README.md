# RAG chat CLI

A zero-dependency command-line client for the RAG knowledge agent. Talks
directly to the chat-handler Lambda Function URL and authenticates as the
native Cognito dev test user (no Google Workspace federation needed).

Requires Node 22 (uses built-in TypeScript type-stripping and native `fetch`).

## Setup

From the repo root, after the stack is deployed to dev:

```bash
# 1. Discover the Function URL + Cognito IDs from the deployed stack
npm run chat -- configure --profile eworkslabs-dev

# 2. Log in as the dev test user (created by the Identity construct in non-prd).
#    On first login you'll be prompted to set a permanent password.
npm run chat -- login

# 3. Chat
npm run chat
```

The dev test user is `dev-tester@example.invalid`, created in the
`dept-engineering` Cognito group (non-prd only). Its temporary password is read
at deploy time from the SSM SecureString
`/rag-knowledge-agent/<env>/dev-test-user-password` — put a value there once
(see `docs/deployment-setup.md`) before deploying.

## Usage

```
you> What is the remote work policy?
agent> ...grounded answer...

citations:
  - cite:abc123
    https://raw-documents-dev-...s3.amazonaws.com/...?presigned...

you> /new      # start a fresh conversation (drops the session ID)
you> /tokens   # show current user + token expiry
you> /help     # list commands
you> /quit     # exit
```

Session ID is carried across turns so the agent retains conversational context.
Expired tokens are refreshed silently from the stored refresh token.

## Files

- `~/.rag-chat-cli/config.json` — Function URL, Cognito user pool ID, client ID, region (mode 0600).
- `~/.rag-chat-cli/creds.json` — id/refresh tokens + expiry (mode 0600).

## Non-interactive login (scripts / CI)

```bash
RAG_CLI_PASSWORD=<temp-password> RAG_CLI_NEW_PASSWORD=<new-password> npm run chat -- login
```

When `RAG_CLI_PASSWORD` is set the password prompt is skipped; when
`RAG_CLI_NEW_PASSWORD` is set the new-password challenge is answered without a
prompt.

## How it works

- `configure` shells out to `aws cloudformation describe-stacks` to read the
  stack outputs (`ChatHandlerFunctionUrl`, `CognitoUserPoolId`,
  `CognitoClientId`).
- `login` calls Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`) directly over
  HTTPS — no AWS SDK, no SigV4 (InitiateAuth is unauthenticated). It handles the
  `NEW_PASSWORD_REQUIRED` challenge via `RespondToAuthChallenge`.
- `chat` POSTs `{ message, sessionId? }` to the Function URL with an
  `Authorization: Bearer <idToken>` header and prints the `{ answer, citations,
  sessionId, turnId }` response.

See `docs/upload-to-s3.md` for how to load documents into the knowledge base so
the agent has something to answer from.
