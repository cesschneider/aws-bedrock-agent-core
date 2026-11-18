# Guia de Ingestão de Documentos e Testes — Versão Console

**Projeto:** RAG Knowledge Agent  
**Público:** Usuários não técnicos com acesso ao AWS Console  
**Última atualização:** Novembro 2026

---

## O que este guia cobre

1. Como enviar documentos para a base de conhecimento
2. Como verificar se os documentos foram processados
3. Como testar perguntas e respostas no console da AWS
4. O que fazer quando algo não funciona

---

## Antes de começar

Você precisa de:

- ✅ Acesso ao **AWS Console** da conta correta
- ✅ Estar na região correta (ex.: **sa-east-1** — São Paulo)
- ✅ Um documento de teste nos formatos: **PDF, Word (.docx), texto (.txt) ou PowerPoint (.pptx)**
- ✅ Tamanho máximo: **50 MB por arquivo**

---

## Passo 1: Abrir o Console da AWS

1. Acesse: https://console.aws.amazon.com/
2. Confirme que está na **região correta** (verifique no canto superior direito)
   - Se necessário, clique na região e selecione **South America (São Paulo)** — `sa-east-1`
3. No menu de serviços, procure por **Bedrock**

---

## Passo 2: Encontrar a Base de Conhecimento

1. No console do Bedrock, clique em **Knowledge bases** no menu lateral esquerdo
2. Você verá uma lista de bases de conhecimento
3. Clique na base do seu projeto (ex.: `al4n-rag-dev`)

> 💡 Se não aparecer nenhuma base, verifique se está na região e conta corretas.

---

## Passo 3: Enviar um Documento

O upload é feito enviando um arquivo para o **bucket S3** que alimenta a base de conhecimento. Tudo é automático depois disso.

### 3.1 Encontrar o bucket de documentos

1. Na página da base de conhecimento, localize a seção **Data sources** (Fontes de dados)
2. Clique na fonte de dados configurada
3. Anote o nome do **bucket S3** mostrado (ex.: `raw-documents-dev-359623881928`)

### 3.2 Enviar o arquivo pelo console S3

1. No menu superior do console AWS, procure por **S3**
2. Na lista de buckets, clique no bucket de documentos (ex.: `raw-documents-dev-359623881928`)
3. O documento deve ser enviado para uma "pasta" seguindo este formato:

   ```
   nome-da-empresa/departamento/nome-do-arquivo.pdf
   ```

   Por exemplo:
   ```
   test-tenant/engineering/documento-teste.pdf
   ```

4. Para criar essa estrutura:
   - Clique em **Create folder** e digite `test-tenant`
   - Entre na pasta, clique em **Create folder** e digite `engineering`
   - Entre na pasta `engineering`
   - Clique em **Upload**
   - Arraste seu arquivo ou clique em **Add files**
   - Clique em **Upload**

5. ✅ Pronto! O arquivo está no S3 e o processamento começa automaticamente.

### 3.3 O que acontece agora (automaticamente)

Você não precisa fazer nada. O sistema:

1. Detecta o novo arquivo no S3
2. Inicia um **job de ingestão** no Bedrock
3. O documento é dividido em trechos pequenos
4. Cada trecho é convertido em vetores (embeddings)
5. Os vetores são armazenados no índice de busca
6. O documento fica disponível para consulta

⏱️ **Tempo típico:** 1 a 5 minutos para documentos pequenos. Documentos maiores podem levar mais tempo.

---

## Passo 4: Verificar se o Documento foi Processado

### 4.1 Verificar o job de ingestão

1. Volte ao console do **Bedrock** → **Knowledge bases**
2. Clique na sua base de conhecimento
3. Na seção **Data sources**, clique na fonte de dados
4. Você verá uma lista de **sync jobs** (trabalhos de sincronização)
5. Verifique o status:
   - 🟢 **Complete** — processado com sucesso
   - 🟡 **In progress** — ainda processando
   - 🔴 **Failed** — houve um erro (veja a seção Troubleshooting)

### 4.2 Sincronizar manualmente (se necessário)

Se o documento não aparecer automaticamente:

1. Na página da fonte de dados, clique em **Sync**
2. Aguarde o status mudar para **Complete**
3. Isso força o Bedrock a escanear o bucket S3 em busca de novos arquivos

---

## Passo 5: Testar Perguntas e Respostas

### 5.1 Testar a Base de Conhecimento (Retrieve)

1. No console do Bedrock → **Knowledge bases**
2. Clique na sua base de conhecimento
3. Clique no botão **Test knowledge base**
4. Um painel de teste vai abrir no lado direito
5. Selecione o modo **Retrieve and generate**
6. Digite uma pergunta relacionada ao documento que você enviou

   **Exemplo:** Se você enviou um documento sobre arquitetura de nuvem:
   ```
   Quais serviços de nuvem são descritos no documento?
   ```

7. Clique em **Run**
8. Verifique o resultado:
   - ✅ A resposta contém informações do seu documento
   - ✅ As **citações** aparecem mostrando de qual trecho veio a informação
   - ✅ Se não há documentos relevantes, o sistema diz isso claramente

### 5.2 Testar o Agente ( conversations)

1. No console do Bedrock, clique em **Agents** no menu lateral
2. Clique no agente do seu projeto (ex.: `al4n-rag-dev`)
3. Clique em **Test**
4. Se solicitado, selecione o alias (ex.: `dev`)
5. Digite uma pergunta na caixa de chat:
   ```
   O que o documento diz sobre arquitetura de nuvem?
   ```
6. Pressione Enter
7. Verifique:
   - ✅ O agente responde com base no documento enviado
   - ✅ Citações são incluídas na resposta
   - ✅ A resposta está na mesma língua da pergunta

---

## Passo 6: Verificar Documentos Enviados

### Listar arquivos no bucket S3

1. Vá ao console **S3**
2. Clique no bucket de documentos
3. Navegue pelas pastas: `test-tenant/engineering/`
4. Você verá todos os arquivos enviados
5. Também verá arquivos `.metadata.json` — estes são gerados automaticamente pelo sistema (não os apague)

---

## Troubleshooting (Problemas Comuns)

### O documento não aparece nos resultados de busca

| Possível causa | O que fazer |
|----------------|-------------|
| O job de ingestão ainda está rodando | Aguarde alguns minutos e verifique novamente |
| O job falhou | Vá em Data sources → Sync para tentar novamente |
| O arquivo está no formato errado | Verifique se é PDF, DOCX, TXT ou PPTX |
| O arquivo está muito grande | Reduza para menos de 50 MB |
| O arquivo está na pasta errada | Verifique se o caminho é `empresa/departamento/arquivo` |

### O agente diz "nenhum documento relevante encontrado"

- **Isso pode estar correto!** Se a pergunta não tem relação com o conteúdo do documento, o sistema corretamente diz que não encontrou nada.
- Tente fazer uma pergunta mais específica sobre o conteúdo do documento.
- Lembre-se: o sistema **só** responde com base nos documentos enviados. Ele nunca usa conhecimento geral.

### O job de ingestão falhou

1. Clique no job que falhou para ver os detalhes
2. Verifique se:
   - O arquivo não está corrompido
   - O formato é suportado (PDF, DOCX, TXT, PPTX)
   - O arquivo não está vazio (0 bytes)
3. Apague o arquivo problemático do S3 e envie novamente
4. Clique em **Sync** na fonte de dados

### Não consigo ver a base de conhecimento no console

- Verifique se está na **região correta** (sa-east-1)
- Verifique se está na **conta AWS correta**
- Verifique com o administrador se você tem permissão para acessar o Bedrock

### Modelo do Bedrock não está disponível

1. No console Bedrock, vá em **Model access**
2. Verifique se **Amazon Nova Pro** e **Titan Embed Text v2** estão habilitados
3. Se não estiverem, clique em **Manage model access** e solicite acesso
4. Aguarde a aprovação (pode levar alguns minutos)

---

## Resumo Visual do Fluxo

```
Você envia um arquivo
      para o S3
         │
         ▼
  Detecção automática
  (evento do S3)
         │
         ▼
  Job de ingestão
  do Bedrock
         │
         ▼
  Documento é dividido
  em trechos pequenos
         │
         ▼
  Trechos viram vetores
  (embeddings)
         │
         ▼
  Vetores são armazenados
  no índice de busca
         │
         ▼
  ✅ Documento disponível
  para perguntas e respostas
```

---

## Glossário

| Termo | Significado |
|-------|-------------|
| **Bucket S3** | Onde os documentos ficam armazenados |
| **Base de conhecimento** | O sistema que organiza os documentos para busca |
| **Job de ingestão** | O processo que transforma documentos em formato pesquisável |
| **Embeddings** | Representação numérica do texto que permite busca por significado |
| **Agente** | A inteligência artificial que responde perguntas usando os documentos |
| **Citação** | Referência ao trecho do documento usado na resposta |
| **Data source** | A fonte de dados (bucket S3) que alimenta a base de conhecimento |
| **Sync** | Sincronização — força o Bedrock a buscar novos arquivos no S3 |
