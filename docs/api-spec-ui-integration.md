# RAG Knowledge Agent — API Spec & UI Integration Guide

Documento de integração para o frontend (Lovable UI). Contém a spec completa
dos endpoints, contratos de request/response, exemplos `curl` e notas de
implementação.

---

## 1. Base URLs (dev)

| Serviço | URL |
|---|---|
| Chat | `https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/` |
| Upload | `https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com` |
| Documents | `https://w1a89nq56l.execute-api.us-east-1.amazonaws.com` |
| Provisioning | `https://8jpargtrs5.execute-api.us-east-1.amazonaws.com` |

Cognito (dev):

| Setting | Valor |
|---|---|
| User Pool ID | `us-east-1_l8i7P13nO` |
| Client ID | `3cps1plup69q20rkqpic0caeik` |
| Region | `us-east-1` |

> As URLs de Upload/Documents/Provisioning são outputs do CloudFormation e
> mudam a cada redeploy. Re-descubra com:
> ```bash
> aws cloudformation describe-stacks --stack-name RagKnowledgeAgent-dev \
>   --profile eworks-dev \
>   --query "Stacks[0].Outputs[?OutputKey=='DocumentsApiDocumentsApiUrlFB3DCC01'].OutputValue" \
>   --output text
> ```

---

## 2. Autenticação

Todos os endpoints autenticados usam **Cognito JWT bearer token** (ID token).

```
Authorization: Bearer <id-token>
```

- **Chat** — Function URL sem authorizer; o Lambda valida o JWT.
- **Upload / Documents** — API Gateway com JWT authorizer (Cognito).
- **Provisioning** — sem auth (sign-up anônimo).

O ID token carrega:

| Claim | Significado |
|---|---|
| `custom:tenantId` | Tenant do usuário (ex. `dev`) |
| `custom:departments` | Departamentos namespaced, separados por vírgula (ex. `dev:dept-engineering,dev:org-wide`) |

> A UI **não** deve filtrar por tenant/departamento — apenas envia o token e
> renderiza o que o backend retorna. O isolamento é feito no servidor.

**Login (USER_PASSWORD_AUTH)** — exemplo com `amazon-cognito-identity-js`:

```ts
import { CognitoUserPool, CognitoUser, AuthenticationDetails } from "amazon-cognito-identity-js";

const pool = new CognitoUserPool({
  UserPoolId: "us-east-1_l8i7P13nO",
  ClientId: "3cps1plup69q20rkqpic0caeik",
});

const user = new CognitoUser({ Username: email, Pool: pool });
user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
  onSuccess: (session) => {
    const idToken = session.getIdToken().getJwtToken();
    // store idToken, attach to all authenticated calls
  },
  onFailure: (err) => { /* show error */ },
});
```

---

## 3. Chat — fazer uma pergunta

`POST /` (Function URL)

**Headers**

```
content-type: application/json
authorization: Bearer <id-token>
```

**Request**

```json
{
  "message": "What is the remote work policy?",
  "sessionId": "optional-uuid-for-multi-turn"
}
```

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `message` | string | sim | A pergunta |
| `sessionId` | string | não | Omita para nova conversa; reutilize para continuar |

**Response `200`**

```json
{
  "answer": "Employees can work from home up to 3 days per week.",
  "citations": [
    { "referenceId": "ref-1", "url": "https://signed.example.com/doc?sig=…" }
  ],
  "sessionId": "uuid",
  "turnId": "2026-08-21T…#abc12345"
}
```

**Erros**

| Status | Body | Significado |
|---|---|---|
| 400 | `{"error":"Missing or invalid 'message' field"}` | Body inválido |
| 401 | `{"error":"…"}` | Token ausente/inválido/expirado |
| 500 | `{"error":"Internal server error"}` | Falha inesperada |

**Exemplo curl**

```bash
curl -X POST https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/ \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ID_TOKEN" \
  -d '{"message":"What is the remote work policy?"}'
```

---

## 4. Upload — obter presigned POST

`POST /uploads`

**Request**

```json
{
  "department": "dept-engineering",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "tags": ["finance", "q3"]
}
```

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `department` | string | sim | Nome do departamento, ou `org-wide` |
| `filename` | string | sim | Nome original do arquivo |
| `contentType` | string | sim | `application/pdf`, `.docx`, `text/plain`, `.pptx` |
| `tags` | string[] | não | Máx 20 tags, 64 chars cada; trim + dedup |

**Content types permitidos**

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (.docx)
- `text/plain`
- `application/vnd.openxmlformats-officedocument.presentationml.presentation` (.pptx)

**Response `200`**

```json
{
  "url": "https://raw-documents-dev-….s3.amazonaws.com/",
  "fields": {
    "key": "dev/dept-engineering/<uuid>-report.pdf",
    "Content-Type": "application/pdf",
    "x-amz-meta-tenant-id": "dev",
    "x-amz-meta-department": "dept-engineering",
    "x-amz-meta-document-id": "<uuid>",
    "x-amz-algorithm": "…",
    "x-amz-credential": "…",
    "x-amz-date": "…",
    "policy": "…",
    "x-amz-signature": "…"
  },
  "key": "dev/dept-engineering/<uuid>-report.pdf",
  "documentId": "<uuid>"
}
```

**Enviando o arquivo** — monte um `multipart/form-data` POST para `url` com
cada entrada de `fields` como campo de formulário + o arquivo no campo `file`.

```ts
const form = new FormData();
for (const [k, v] of Object.entries(fields)) form.append(k, v);
form.append("file", file); // File object
await fetch(url, { method: "POST", body: form });
```

**Erros**

| Status | Body | Significado |
|---|---|---|
| 400 | `{"error":"…"}` | Campo ausente/inválido ou content type não suportado |
| 400 | `{"error":"tags must be an array of strings"}` | `tags` não é array |
| 400 | `{"error":"too many tags (max 20)"}` | Mais de 20 tags |
| 401 | `{"error":"Missing tenant claim (custom:tenantId)"}` | Token sem tenant |
| 403 | `{"error":"Not a member of department \"…\""}` | Sem acesso ao departamento |

**Exemplo curl**

```bash
curl -X POST https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com/uploads \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ID_TOKEN" \
  -d '{"department":"dept-engineering","filename":"report.pdf","contentType":"application/pdf","tags":["finance","q3"]}'
```

---

## 5. Documents — listar / detalhar / remover

### 5.1 Listar documentos

`GET /documents`

Retorna todos os documentos que o usuário pode acessar (seus departamentos +
`org-wide`), mais recentes primeiro.

**Response `200`**

```json
{
  "documents": [
    {
      "documentId": "11111111-1111-1111-1111-111111111111",
      "tenantId": "dev",
      "department": "dept-engineering",
      "filename": "report.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 1024,
      "tags": ["finance", "q3"],
      "status": "INDEXED",
      "uploadedBy": "dev-tester",
      "uploadedAt": "2026-08-21T00:00:00.000Z",
      "indexedAt": "2026-08-21T00:00:05.000Z"
    }
  ]
}
```

**Referência de campos**

| Campo | Tipo | Notas |
|---|---|---|
| `documentId` | string | Id estável; use para get/delete |
| `tenantId` | string | Org do documento |
| `department` | string | Nome do departamento (human-facing) |
| `filename` | string | Nome original |
| `contentType` | string | MIME type |
| `sizeBytes` | number | Tamanho em bytes (0 até indexar) |
| `tags` | string[] | Tags do usuário (pode ser vazio) |
| `status` | string | `PENDING` \| `INDEXED` \| `FAILED` |
| `uploadedBy` | string | Usuário que enviou |
| `uploadedAt` | string | ISO 8601 |
| `indexedAt` | string \| undefined | ISO 8601, definido após indexar |

**Exemplo curl**

```bash
curl https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents \
  -H "authorization: Bearer $ID_TOKEN"
```

### 5.2 Detalhar um documento

`GET /documents/{documentId}`

**Response `200`** — mesmo shape de um item da lista, mas objeto único (sem
wrapper `documents`).

**Erros**

| Status | Body | Significado |
|---|---|---|
| 404 | `{"error":"Document not found"}` | Não existe no tenant do usuário |
| 403 | `{"error":"Not a member of the document's department"}` | Existe mas sem acesso |

**Exemplo curl**

```bash
curl https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents/11111111-1111-1111-1111-111111111111 \
  -H "authorization: Bearer $ID_TOKEN"
```

### 5.3 Remover um documento

`DELETE /documents/{documentId}`

Remove o objeto S3, o sidecar `.metadata.json` e o registro. O documento deixa
de ser recuperável via chat após a próxima ingestão.

**Response `200`**

```json
{ "deleted": true, "documentId": "11111111-1111-1111-1111-111111111111" }
```

**Erros** — mesmos `404` / `403` do GET.

**Exemplo curl**

```bash
curl -X DELETE https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents/11111111-1111-1111-1111-111111111111 \
  -H "authorization: Bearer $ID_TOKEN"
```

---

## 6. Provisioning — criar/confirmar tenant (sem auth)

### 6.1 Sign-up

`POST /signup`

```json
{ "name": "Acme Corp", "adminEmail": "admin@acme.com", "domain": "acme.com" }
```

**Response `201`**

```json
{ "domain": "acme.com", "tenantId": "acme-com", "status": "PENDING" }
```

### 6.2 Confirmar

`POST /confirm`

```json
{ "domain": "acme.com", "token": "<verification-token>" }
```

**Response `200`**

```json
{ "domain": "acme.com", "tenantId": "acme-com", "status": "ACTIVE" }
```

> O token de verificação é enviado por email (ou logado em dev). O tenant só
> fica utilizável após `ACTIVE`.

---

## 7. Notas de implementação (UI)

- **Tela de documentos**: nova aba que chama `GET /documents` e renderiza
  tabela/lista com `filename`, `department`, `sizeBytes` (formatado), `tags`
  (chips), `status` (badge) e `uploadedAt` (data/hora formatada).
- **Detalhe**: clique na linha → `GET /documents/{id}` (ou reusa o item da
  lista) e mostra o detalhe completo.
- **Remover**: ação de delete → `DELETE /documents/{id}` → recarrega a lista.
  Confirme antes de deletar.
- **Tags no upload**: input de tags (separado por vírgula ou chips) no
  formulário; envie o array no campo `tags`.
- **Status**: documento recém-enviado fica `PENDING` até a ingestão concluir
  (segundos). Faça polling de `GET /documents` ou re-fetch após um delay para
  refletir `INDEXED`.
- **Erros**: exiba o body de erro (`{"error":"…"}`) verbatim, como nas telas
  existentes.
- **Token**: armazene o ID token em memória/localStorage; anexe a todas as
  chamadas autenticadas; renove silenciosamente e redirecione ao login em 401.
- **Config**: centralize as 4 base URLs em um único arquivo de config para
  trocar por ambiente facilmente.

---

## 8. Fluxo completo de exemplo (upload → listar → deletar)

```bash
# 1. Login e captura do ID token (via UI ou CLI)
ID_TOKEN="<id-token>"

# 2. Upload com tags
curl -X POST https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com/uploads \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ID_TOKEN" \
  -d '{"department":"dept-engineering","filename":"report.pdf","contentType":"application/pdf","tags":["finance","q3"]}'
# → { "url": "...", "fields": {...}, "key": "...", "documentId": "<uuid>" }

# 3. POST multipart do arquivo para S3 (usar url + fields do passo 2)

# 4. Listar documentos
curl https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents \
  -H "authorization: Bearer $ID_TOKEN"

# 5. Detalhar
curl https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents/<uuid> \
  -H "authorization: Bearer $ID_TOKEN"

# 6. Remover
curl -X DELETE https://w1a89nq56l.execute-api.us-east-1.amazonaws.com/documents/<uuid> \
  -H "authorization: Bearer $ID_TOKEN"
```
