# Lovable Build Prompt — RAG Knowledge Agent UI

Paste the text below (from "## Build Prompt" onward) into Lovable as a single
prompt. It is self-contained: it includes the API contract, the auth model,
and the exact screens/behaviors to build.

---

## Build Prompt

Build a multi-tenant RAG knowledge-agent web app (React + TypeScript) that
talks to an existing AWS backend. Four screens, one shared auth context.

### Backend (already deployed — do NOT reimplement)

Base URLs (dev):

- Chat: `https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/`
- Upload: `https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com`
- Provisioning: `https://8jpargtrs5.execute-api.us-east-1.amazonaws.com`

Cognito (dev): User Pool `us-east-1_l8i7P13nO`, Client `3cps1plup69q20rkqpic0caeik`, region `us-east-1`.

### Authentication model (critical)

- Users log in with **Cognito username + password** (USER_PASSWORD_AUTH flow).
  Use the Cognito Hosted UI or the `amazon-cognito-identity-js` / AWS Amplify
  Auth library. Store the returned **ID token**.
- Every authenticated request sends `Authorization: Bearer <idToken>`.
- The ID token carries `custom:tenantId` (the user's org) and
  `cognito:groups` (their departments). The backend enforces isolation from
  these claims — the UI must NOT try to filter by tenant/department itself;
  it just sends the token and displays what comes back.
- Handle token expiry: refresh silently, and on 401 redirect to login.

### Screen 1 — Login

- Username + password form. On success, store the ID token and go to Chat.
- Show a clear error on invalid credentials.

### Screen 2 — Chat (primary)

- A chat interface: message list + input box + send.
- On send, `POST` to the Chat URL with `{ "message": "<text>", "sessionId": "<current session id or omit>" }`.
- Keep the returned `sessionId` and send it on the next message (multi-turn).
- Render the `answer` as the assistant bubble.
- Render `citations` as clickable links under the answer (label each with its
  `referenceId`, link to its `url`).
- If the answer is the zero-result message ("No relevant company documents
  were found…"), show it as a neutral notice, not an error.
- Show a loading state while awaiting the response.

### Screen 3 — Document Upload

- A form: file picker + department selector + submit.
- Department selector: a text input or dropdown. Accept a department name
  (e.g. `engineering`) or the special value `org-wide`. (The backend rejects
  uploads to departments the user doesn't belong to — surface that 403 error
  clearly.)
- On submit:
  1. `POST /uploads` with `{ "department", "filename", "contentType" }` and the
     bearer token. `contentType` must be one of: `application/pdf`,
     `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
     `text/plain`,
     `application/vnd.openxmlformats-officedocument.presentationml.presentation`.
  2. The response is `{ url, fields, key }`. Build a `multipart/form-data`
     POST to `url` containing every entry in `fields` as a form field, plus
     the file under the `file` field. (This is an S3 presigned POST.)
  3. Show success (with the object `key`) or the error.
- Restrict the file picker to `.pdf`, `.docx`, `.txt`, `.pptx`.

### Screen 4 — New Tenant (provisioning)

- A form: organization name, admin email, domain.
- On submit, `POST /signup` (NO auth header) with
  `{ "name", "adminEmail", "domain" }`.
- Show the returned `{ domain, tenantId, status }` (status will be `PENDING`).
- A second form (or step) to confirm: `POST /confirm` with
  `{ "domain", "token" }`. Show the resulting `status` (`ACTIVE`).
- Note in the UI: the verification token is emailed to the admin (or logged
  in dev); the tenant is only usable after confirmation.

### Cross-cutting requirements

- A top nav or tab bar to switch between Chat / Upload / New Tenant.
- Store the ID token in memory/localStorage; attach it to all authenticated
  calls.
- Centralize the three base URLs in a single config file so they're easy to
  change per environment.
- Handle and display backend error bodies (`{ "error": "…" }`) verbatim.
- Clean, professional UI. No mock data — wire everything to the real
  endpoints above.

### Important constraints

- There is **no user-management API** yet. Do not build a "create user /
  assign department" screen — users are provisioned outside this app (Google
  Workspace federation or native Cognito). If you need a placeholder, show a
  note that user management is handled by the admin/backend.
- Do not invent endpoints. Only the four documented above exist.
