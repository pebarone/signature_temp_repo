# Deploy no OpenShift (exemplo)

Arquivos deste diretório são **exemplos**: nenhum endpoint, imagem, registry ou credencial real está
configurado aqui. Ajuste nomes, namespace e `storageClassName` ao cluster.

## Por que um PVC

O orquestrador mantém estado em disco (`DATA_DIR`):

| Caminho | Conteúdo |
|---|---|
| `$DATA_DIR/state/orchestrator.db` | SQLite: mapa agreement -> workflow, estado e histórico de eventos |
| `$DATA_DIR/state/tokens.json` | tokens OAuth do Adobe Sign (modo 600) |
| `$DATA_DIR/logs/` | `audit-YYYY-MM-DD.log` / `error-YYYY-MM-DD.log` (retenção `LOG_RETENTION_DAYS`, padrão 15) |

Sem volume persistente, um restart do pod apaga tudo e os webhooks seguintes ficam sem acordo mapeado.

## Passos

1. Criar o PVC: `oc apply -f deploy/openshift/pvc.yaml` (RWO, 1Gi).
2. Criar o Secret com as variáveis sensíveis (valores fora do repositório), por exemplo:

   ```bash
   oc create secret generic signature-orchestrator-env \
     --from-literal=CLIENT_ID=... --from-literal=CLIENT_SECRET=... \
     --from-literal=SIGNATURE_SECRET=... --from-literal=LOG_USER=... --from-literal=LOG_PASS=... \
     --from-literal=OTCS_USER=... --from-literal=OTCS_PASS=...
   ```

3. Aplicar um Deployment como o abaixo (exemplo):

   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: signature-orchestrator
   spec:
     replicas: 1                # PVC RWO + SQLite: exatamente uma réplica
     strategy:
       type: Recreate           # nunca dois pods ao mesmo tempo sobre o mesmo volume
     selector:
       matchLabels: { app: signature-orchestrator }
     template:
       metadata:
         labels: { app: signature-orchestrator }
       spec:
         containers:
           - name: app
             image: <imagem-do-orquestrador>   # build da imagem: ver nota abaixo
             command: ["node", "server/index.js"]
             ports:
               - containerPort: 3000
             env:
               - { name: NODE_ENV, value: production }
               - { name: DATA_DIR, value: /data }
               - { name: REQUIRE_PERSISTENT_STORAGE, value: "true" }
               - { name: PORT, value: "3000" }
               - { name: PUBLIC_URL, value: https://<rota-publica> }
               - { name: OTCS_BASE, value: https://<content-server>/<caminho-api> }
               # Região do Adobe (padrão EU1; produção usa NA4):
               # - { name: ADOBE_API_BASE, value: https://api.na4.adobesign.com }
               # - { name: ADOBE_AUTH_BASE, value: https://secure.na4.adobesign.com }
             envFrom:
               - secretRef: { name: signature-orchestrator-env }
             volumeMounts:
               - { name: data, mountPath: /data }
             readinessProbe:
               httpGet: { path: /health, port: 3000 }
         volumes:
           - name: data
             persistentVolumeClaim:
               claimName: signature-orchestrator-data
   ```

   Com `REQUIRE_PERSISTENT_STORAGE=true` o processo **recusa subir** se `DATA_DIR` não estiver definido
   (ou se o storage for efêmero), em vez de rodar perdendo estado.

4. Expor com um `Service` + `Route` HTTPS; a URL pública vira `PUBLIC_URL`, o `redirect_uri` do OAuth
   (`<PUBLIC_URL>/admin/callback`) e a URL do webhook (`<PUBLIC_URL>/webhook`) no Adobe Sign.
5. Autorizar o Adobe uma vez em `<PUBLIC_URL>/admin/login` (grava `tokens.json` no volume).
   Alternativa: semear `ADOBE_REFRESH_TOKEN` no Secret.

## Build da imagem: `better-sqlite3` é nativo

`better-sqlite3` é um addon nativo. O `npm ci` baixa um binário pré-compilado (prebuild) quando existe um
para a combinação Node/OS/arquitetura da imagem base. Quando não existe (ex.: imagem muito nova, musl/alpine
ou arquitetura incomum), o `npm` recompila na hora e a imagem de build precisa de **python3, make e g++**.
Opções:

- usar uma imagem base glibc (Debian/UBI) com Node 20+ (o `better-sqlite3` 12.x exige Node 20 ou mais novo) — normalmente o prebuild é baixado e nada mais é necessário;
- ou instalar `python3 make g++` no estágio de build (multi-stage) e copiar só `node_modules` para a imagem final;
- se o build não tem acesso à internet para baixar o prebuild (registry/proxy restrito), prever o mirror ou
  compilar a partir do código-fonte (caso acima).

O build e o runtime precisam ter o mesmo Node/OS/arquitetura (o `.node` compilado não é portável).

## Operação

- `GET /health` (sem autenticação) para probes.
- `GET /admin/agreements` e `POST /admin/reconcile/:id` (Basic Auth `LOG_USER`/`LOG_PASS`) mostram o estado dos
  acordos e forçam a reconciliação. Acordos em `needs_attention` aparecem com `attentionReason`.
- Backup: copiar `$DATA_DIR/state/` (o SQLite está em modo WAL: copiar também os arquivos `-wal`/`-shm`
  ou usar `sqlite3 orchestrator.db ".backup ..."`).
