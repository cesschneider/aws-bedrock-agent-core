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
| Catalog (departamentos/tags) | `https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com` |
| Organizations (criar org) | `https://hvn1deth68.execute-api.us-east-1.amazonaws.com` |
| Members (membros da org) | `https://qsdndxv5o1.execute-api.us-east-1.amazonaws.com` |

> **Spec pública da API (endpoint sem auth)** — serve a documentação completa
> e sempre atualizada como JSON (ou HTML com `Accept: text/html`):
>
> ```
> https://7xqw4qroq2.execute-api.us-east-1.amazonaws.com/docs
> ```
>
> Use essa URL como fonte de verdade para a UI; o conteúdo é embutido no build
> e fica sempre consistente com o código deployado.

Cognito (dev):

| Setting | Valor |
|---|---|
| User Pool ID | `us-east-1_l8i7P13nO` |
| Client ID | `3cps1plup69q20rkqpic0caeik` |
| Region | `us-east-1` |

> As URLs de Upload/Documents/Organizations/Members são outputs do CloudFormation e
> mudam a cada redeploy. Re-descubra com:
> ```bash
> aws cloudformation describe-stacks --stack-name RagKnowledgeAgent-dev \
>   --profile eworks-dev \
>   --query "Stacks[0].Outputs[?OutputKey=='DocumentsApiDocumentsApiUrlFB3DCC01'].OutputValue" \
>   --output text
> ```

---

## 2. Autenticação

Todos os endpoints autenticados aceitam **dois tipos de JWT bearer token**,
validados por um **authorizer Lambda dual-issuer** (rota por `iss`):

| Issuer | Algoritmo | Token | Uso |
|---|---|---|---|
| Cognito (`https://cognito-idp.us-east-1.amazonaws.com/us-east-1_l8i7P13nO`) | RS256 | ID token | Login por senha (fluxo legado) |
| Supabase / Lovable Cloud (`https://lxqsievatwcbxhwhubkc.supabase.co/auth/v1`) | ES256 | Access token | Login Google via Lovable UI |

```
Authorization: Bearer ***
```

- **Chat** — Function URL sem authorizer; o Lambda valida o JWT (dual-issuer).
- **Upload / Documents / Catalog / Organizations / Members** — API Gateway com
  authorizer Lambda dual-issuer (mesma lógica de validação do chat).

O authorizer valida `iss`, `aud`, `exp` e a assinatura (JWKS com cache +
refetch em rotação de chave) e devolve um **contexto normalizado** para os
handlers:

| Campo | Significado |
|---|---|
| `tenantId` | Tenant do usuário. Cognito: `custom:tenantId`. Supabase: resolvido no servidor pela tabela de membership (por `email`). **Ausente** para usuário sem organização |
| `email` | Email do usuário (normalizado lowercase) |
| `departments` | Departamentos namespaced, separados por vírgula (ex. `acme-corporation:dept-engineering,acme-corporation:org-wide`) |
| `userId` | Identidade estável do usuário |

> A UI **não** deve filtrar por tenant/departamento — apenas envia o token e
> renderiza o que o backend retorna. O isolamento é feito no servidor.

> **Supabase (Lovable Cloud)** — o token é o access token do Supabase. O tenant
> é resolvido pelo `email` contra a tabela de membership; sem membership o
> request falha com `401` (fail-closed). O `sub` do Supabase é a identidade
> estável do usuário.

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
  "sessionId": "optional-uuid-for-multi-turn",
  "departments": ["dept-engineering"],
  "tags": ["finance"]
}
```

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `message` | string | sim | A pergunta |
| `sessionId` | string | não | Omita para nova conversa; reutilize para continuar |
| `departments` | string[] | não | Subconjunto dos departamentos do usuário para restringir a busca |
| `tags` | string[] | não | Restringe a retrieval a documentos com pelo menos uma dessas tags |

> `departments` só pode **restringir**, nunca expandir: pedir um departamento que
> o usuário não pertence retorna `403`. `tags` deve vir do catálogo normalizado
> do tenant (ver seção 7).

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

## 6. Organizations — criar organização (Google account)

Base: `https://hvn1deth68.execute-api.us-east-1.amazonaws.com`

Fluxo de criação de conta: o usuário autoriza com **Google**, escolhe o nome
da organização, e a org é criada junto com o usuário como **admin**. Não há
ação de domínio nem token de verificação por email.

### 6.1 Verificar disponibilidade do nome

`GET /organizations/check-name?name=…`

**Response `200`**

```json
{ "name": "Acme Corporation", "slug": "acme-corporation", "available": true }
```

Quando indisponível ou inválido:

```json
{ "name": "Acme Corporation", "slug": "acme-corporation", "available": false }
```

```json
{ "name": "!!!", "slug": "", "available": false, "reason": "invalid-name" }
```

| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | Nome enviado (eco) |
| `slug` | string | Slug derivado (vazio se inválido) |
| `available` | boolean | `true` se o nome é válido e livre |
| `reason` | string \| undefined | `invalid-name` quando o nome não gera slug válido |

### 6.2 Criar organização

`POST /organizations`

```json
{ "name": "Acme Corporation" }
```

**Response `201`**

```json
{
  "tenantId": "acme-corporation",
  "name": "Acme Corporation",
  "adminEmail": "user@gmail.com",
  "status": "ACTIVE"
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `tenantId` | string | Slug do nome; é o tenant usado em todas as chamadas |
| `name` | string | Nome original |
| `adminEmail` | string | Email Google do criador (vira admin) |
| `status` | string | `ACTIVE` |

**Erros**

| Status | Body | Significado |
|---|---|---|
| 400 | `{"error":"Invalid organization name"}` | Nome não gera slug válido |
| 409 | `{"error":"Organization name already taken"}` | Nome já em uso |
| 409 | `{"error":"You already belong to an organization"}` | Usuário já é membro de uma org |

> **Regra de slug** — lowercase, alfanumérico/hífen, máx 64 chars. `"Acme
> Corporation"` → `acme-corporation`. Nomes que colapsam para slug vazio são
> rejeitados.

> **Um usuário = uma organização.** Após criar/entrar em uma org, o usuário
> não pode criar outra. O `custom:tenantId` passa a ser emitido no próximo
> login (o token atual não muda até reautenticar).

**Exemplo curl**

```bash
# Verificar disponibilidade
curl "https://hvn1deth68.execute-api.us-east-1.amazonaws.com/organizations/check-name?name=Acme%20Corporation" \
  -H "authorization: Bearer ***"

# Criar organização
curl -X POST https://hvn1deth68.execute-api.us-east-1.amazonaws.com/organizations \
  -H "content-type: application/json" \
  -H "authorization: Bearer ***" \
  -d '{"name":"Acme Corporation"}'
```

---

## 7. Members — gerenciar membros da organização

Base: `https://qsdndxv5o1.execute-api.us-east-1.amazonaws.com`

O admin convida usuários por email; o convidado aceita o convite e passa a
fazer parte da organização (acesso aos dados do tenant).

**Regras de acesso**

| Operação | Quem pode |
|---|---|
| Listar (`GET`) | Qualquer membro do tenant |
| Convidar / remover (`POST` / `DELETE`) | Apenas o admin do tenant |

### 7.1 Listar membros

`GET /members`

**Response `200`**

```json
{
  "members": [
    { "email": "admin@acme.com", "role": "admin", "status": "ACTIVE" },
    { "email": "user@acme.com", "role": "member", "status": "ACTIVE" },
    { "email": "pending@acme.com", "role": "member", "status": "INVITED" }
  ]
}
```

### 7.2 Convidar membro

`POST /members/invite`

```json
{ "email": "user@acme.com" }
```

**Response `201`**

```json
{ "email": "user@acme.com", "role": "member", "status": "INVITED" }
```

> O convite é registrado no tenant. Quando o convidado autentica com Google
> (mesmo email), ele passa a fazer parte da organização automaticamente.

### 7.3 Aceitar convite

`POST /members/accept`

```json
{ "tenantId": "acme-corporation" }
```

**Response `200`**

```json
{ "email": "user@acme.com", "role": "member", "status": "ACTIVE" }
```

### 7.4 Remover membro

`DELETE /members/{email}`

**Response `200`**

```json
{ "removed": true, "email": "user@acme.com" }
```

**Erros comuns**

| Status | Body | Significado |
|---|---|---|
| 403 | `{"error":"Only the tenant admin can manage members"}` | Usuário não é admin |
| 404 | `{"error":"Member not found"}` | Email não é membro do tenant |

**Exemplo curl**

```bash
# Listar membros
curl https://qsdndxv5o1.execute-api.us-east-1.amazonaws.com/members \
  -H "authorization: Bearer ***"

# Convidar
curl -X POST https://qsdndxv5o1.execute-api.us-east-1.amazonaws.com/members/invite \
  -H "content-type: application/json" \
  -H "authorization: Bearer ***" \
  -d '{"email":"user@acme.com"}'
```

---

## 8. Catalog — departamentos e tags por tenant

Base: `https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com`

Gerencia listas de departamentos (para dropdowns administrativos) e tags
normalizadas (para classificar conteúdo). Todos os endpoints exigem JWT.

**Regras de acesso**

| Operação | Quem pode |
|---|---|
| Listar (`GET`) | Qualquer membro do tenant |
| Criar / remover (`POST` / `DELETE`) | Apenas o admin do tenant (membership `role: admin`) |

**Normalização de nomes** — lowercase, alfanumérico/hífen/underscore, máx 64
chars. Nome inválido → `400`.

### 8.1 Departamentos

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/catalog/departments` | Lista ordenada de departamentos |
| `POST` | `/catalog/departments` | Cria um departamento |
| `DELETE` | `/catalog/departments/{name}` | Remove um departamento |

**Listar** — response `200`

```json
{ "departments": ["dept-engineering", "dept-hr"] }
```

**Criar** — request

```json
{ "name": "dept-engineering" }
```

Response `201`

```json
{ "name": "dept-engineering", "kind": "department" }
```

**Remover** — response `200`

```json
{ "deleted": true, "name": "dept-engineering", "kind": "department" }
```

### 8.2 Tags

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/catalog/tags` | Lista ordenada de tags normalizadas |
| `POST` | `/catalog/tags` | Cria uma tag |
| `DELETE` | `/catalog/tags/{name}` | Remove uma tag |

**Listar** — response `200`

```json
{ "tags": ["finance", "q3"] }
```

**Criar** — request

```json
{ "name": "finance" }
```

Response `201`

```json
{ "name": "finance", "kind": "tag" }
```

**Erros comuns**

| Status | Body | Significado |
|---|---|---|
| 400 | `{"error":"Invalid name: use lowercase letters, digits, hyphens, or underscores (max 64 chars)"}` | Nome inválido |
| 403 | `{"error":"Only the tenant admin can manage the catalog"}` | Usuário não é admin |
| 409 | `{"error":"… already exists"}` | Nome já existe |

**Exemplo curl**

```bash
# Listar departamentos
curl https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com/catalog/departments \
  -H "authorization: Bearer ***"

# Criar uma tag
curl -X POST https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com/catalog/tags \
  -H "content-type: application/json" \
  -H "authorization: Bearer ***" \
  -d '{"name":"finance"}'

# Remover uma tag
curl -X DELETE https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com/catalog/tags/finance \
  -H "authorization: Bearer ***"
```

> **Tags no upload** — quando o tenant tem um catálogo de tags populado, o
> upload rejeita tags fora dele (`400 Unknown tags: …`). Catálogo vazio aceita
> qualquer tag (compatibilidade). A UI deve popular o seletor de tags a partir
> de `GET /catalog/tags`.

---

## 9. Notas de implementação (UI)

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
- **Token**: armazene o token (Cognito ID token ou Supabase access token) em
  memória/localStorage; anexe a todas as chamadas autenticadas; renove
  silenciosamente e redirecione ao login em 401.
- **Config**: centralize as 7 base URLs em um único arquivo de config para
  trocar por ambiente facilmente.
- **Criação de conta (Google)**: após o login com Google, se o token não tiver
  `tenantId` (Cognito: `custom:tenantId`; Supabase: sem membership), mostre a
  tela de criação de organização. Valide o nome em tempo real com
  `GET /organizations/check-name?name=…` (debounce) e habilite o botão "Criar"
  apenas quando `available: true`. Ao criar (`POST /organizations`), o usuário
  vira admin — reautentique para obter o novo `tenantId` no token.
- **Gerenciar membros**: se o usuário for admin, exiba a tela de membros
  (`GET /members`), com convite por email (`POST /members/invite`) e remoção
  (`DELETE /members/{email}`). Não-admin veem a lista em modo leitura.
- **Dropdowns de departamento/tags**: popule os seletores de filtro (chat) e
  de tags (upload) a partir de `GET /catalog/departments` e `GET /catalog/tags`.
  Não deixe o usuário digitar tags livres quando o catálogo estiver populado.
- **Admin UI**: se o usuário for admin do tenant, exiba uma tela para
  criar/remover departamentos e tags (`POST`/`DELETE` em `/catalog/*`).
  Não-admin veem as listas apenas em modo leitura.
- **Filtro de chat**: envie `departments` e/ou `tags` opcionais no request do
  chat para restringir a retrieval. `departments` deve ser subconjunto dos
  departamentos do usuário (o backend rejeita expansão com `403`).

---

## 10. Fluxo completo de exemplo (upload → listar → deletar)

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
