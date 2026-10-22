# Deploy no OpenShift

Este diretório traz os artefatos para rodar o orquestrador no OpenShift:

- `pvc.yaml`, `configmap.yaml`, `deployment.yaml`, `service.yaml` e `route.yaml`, aplicados juntos com `oc apply -k` (via `kustomization.yaml`);
- `secret.example.yaml`: modelo do Secret. **Não** é aplicado pelo `kustomization.yaml`;
- `Containerfile`: imagem do orquestrador.

Antes de aplicar, troque todos os valores `<...>`: namespace, registry e tag da imagem, host da rota, `PUBLIC_URL` e `storageClassName`.
Valores com `<` ou `>` não são válidos em nomes de host ou de imagem. A `OTCS_BASE` do `configmap.yaml` já aponta para o
Content Server de produção; troque se o alvo for outro.

## Resumo do storage (leia antes do restante)

O SQLite do orquestrador é o estado crítico: sem ele, o sistema não sabe a qual workflow pertence cada acordo do Adobe Sign.

- **Obrigatório:** volume de **bloco**, `ReadWriteOnce` (RWO), com filesystem local (ext4 ou xfs). Exemplos: EBS, disco gerenciado do Azure, vSphere, GCP Persistent Disk, Ceph RBD.
- **Obrigatório:** **uma réplica** e estratégia **`Recreate`** (já definidas no `deployment.yaml`). O SQLite em modo WAL usa locks POSIX de arquivo e memória compartilhada (`-shm`) entre processos do **mesmo host**. Dois processos, ou um volume de rede, corrompem o banco ou travam.
- **Evitar:** NFS, SMB/Azure Files, CephFS, AWS EFS e qualquer classe `ReadWriteMany`. A lista completa está na seção 1.3.

---

## 1. Requisitos de storage

### 1.1 O que é gravado

`DATA_DIR` vale `/data` no pod, que é a montagem do PVC `signature-orchestrator-data`.

| Caminho em `/data` | Conteúdo |
|---|---|
| `state/orchestrator.db` (+ `-wal` e `-shm`) | SQLite: mapa acordo->workflow, estado, tentativas (retries) e histórico de eventos (até 50 por acordo). Guarda metadados e resumos de eventos, não os PDFs. Contém e-mails de signatários |
| `state/tokens.json` | tokens OAuth do Adobe Sign (modo 600) |
| `logs/` | `audit-YYYY-MM-DD.log` e `error-YYYY-MM-DD.log`, com retenção de `LOG_RETENTION_DAYS` (padrão 15) |
| `inprocess/` | reservada: criada no start, sem uso atual (os PDFs são processados em memória) |

O banco, os tokens e os logs contêm dados pessoais. Proteja o volume e os backups com o mesmo cuidado.

### 1.2 Classes de storage recomendadas

| Plataforma | `storageClassName` | Observação |
|---|---|---|
| OpenShift Data Foundation | `ocs-storagecluster-ceph-rbd` | bloco RBD, RWO |
| AWS | `gp3-csi` (ou `gp2-csi`) | EBS |
| Azure | `managed-csi` (ou `managed-premium`) | disco gerenciado |
| vSphere | `thin-csi` | vSphere CSI |
| GCP | `standard-csi` ou `ssd-csi` | Persistent Disk |

### 1.3 Classes de storage a evitar

| Classe (exemplos) | Motivo |
|---|---|
| Qualquer NFS (ex.: `nfs-client`, `nfs-csi`) | filesystem de rede: os locks e o `-shm` do SQLite não são confiáveis |
| `ocs-storagecluster-cephfs` (CephFS) | compartilhado (RWX) pela rede: mesmo problema de locks |
| `azurefile-csi` (Azure Files) | protocolo SMB, sem a semântica de locks que o SQLite em WAL exige |
| `efs-sc` (AWS EFS) | NFS: mesmo problema |
| Qualquer classe `ReadWriteMany` | permite mais de um pod no mesmo volume, e a aplicação não foi projetada para isso |

### 1.4 Como checar a classe

```bash
oc get storageclass                                    # nomes, (default) e PROVISIONER
oc get storageclass <nome> -o jsonpath='{.provisioner}'
oc get storageclass <nome> -o jsonpath='{.allowVolumeExpansion}'
```

| Provisioner | Decisão |
|---|---|
| `openshift-storage.rbd.csi.ceph.com` | usar (bloco) |
| `ebs.csi.aws.com` | usar (bloco) |
| `disk.csi.azure.com` ou `kubernetes.io/azure-disk` | usar (disco) |
| `csi.vsphere.vmware.com` | usar (bloco) |
| `pd.csi.storage.gke.io` | usar (bloco) |
| `openshift-storage.cephfs.csi.ceph.com` | evitar (CephFS, RWX) |
| `efs.csi.aws.com` | evitar (EFS, NFS) |
| `file.csi.azure.com` | evitar (Azure Files, SMB) |
| `nfs.csi.k8s.io` ou qualquer provisioner NFS | evitar |

Se o `storageClassName` estiver comentado no `pvc.yaml`, vale a classe marcada como `(default)`: confirme que ela aparece como "usar".
Depois de aplicar, o PVC deve estar `Bound` com `ACCESS MODES` `RWO`:

```bash
oc get pvc signature-orchestrator-data
```

### 1.5 Capacidade

O PVC começa com **2Gi**. O que ocupa espaço:

- **Logs**: a parcela que cresce. Há um `audit` e um `error` por dia, mantidos por `LOG_RETENTION_DAYS` dias (15 por padrão). O tamanho depende do volume de eventos e **não foi medido** neste repositório.
- **SQLite**: metadados e histórico de até 50 eventos por acordo. Cresce com o número de acordos. O arquivo `-wal` cresce entre os checkpoints.
- **Backups**: se gravados em `/data`, ocupam o mesmo volume. Por isso a receita de backup usa `/tmp` do contêiner.

Monitore com `oc exec deploy/signature-orchestrator -- du -sh /data/state /data/logs`. Se o volume encher, as gravações falham.
Para ampliar o PVC, a classe precisa ter `allowVolumeExpansion: true`.

### 1.6 Permissões (SCC restricted-v2)

O `deployment.yaml` não fixa `runAsUser` nem `fsGroup`. Com a SCC `restricted-v2`, o OpenShift executa o contêiner com um UID aleatório
do intervalo do namespace e aplica um `fsGroup` automático ao volume, que fica gravável pelo grupo. A imagem declara `USER 1001`, mas o cluster
sobrescreve o UID.

```bash
oc get pod -l app=signature-orchestrator -o jsonpath='{.items[0].metadata.annotations.openshift\.io/scc}'
oc get pod -l app=signature-orchestrator -o jsonpath='{.items[0].spec.securityContext.fsGroup}'
```

Esperado: `restricted-v2` e um número dentro do intervalo `openshift.io/sa.scc.supplemental-groups` do namespace.
Se o log mostrar `EACCES` em `/data`, confira esses dois valores. Se a SCC for outra, ou o `fsGroup` estiver vazio, o volume pode não estar
gravável pelo UID do contêiner: acione o time de plataforma. Não altere a SCC nem rode o contêiner como root sem análise.

### 1.7 O que se perde sem PVC

Sem PVC (ou em storage efêmero, como no QA do Render, ver `docs/QA_RENDER.md`), todo restart, redeploy ou troca de pod apaga:

- o **mapa acordo->workflow**. Novos webhooks tentam adotar acordos pelo `externalId` com `ADOPT_UNKNOWN_AGREEMENTS=true`;
  sem novo evento, use `POST /admin/adopt/:id`. O poller não enumera acordos desconhecidos e `POST /admin/reconcile/:id`
  responde 404 até a adoção. A adoção não restaura o histórico nem os retries perdidos;
- a **fila de retries** e o estado das tentativas;
- os **tokens OAuth** do Adobe (é preciso autorizar de novo, ou usar `ADOBE_REFRESH_TOKEN`);
- os **logs**.

### 1.8 Backup e restore

**Por que não basta copiar o `.db`.** Em modo WAL, as transações confirmadas vão primeiro para `orchestrator.db-wal` e só depois são
incorporadas ao `.db` (checkpoint). Copiar só o `.db` pode deixar de fora mudanças já confirmadas (um mapa novo, um evento já recebido) e,
se a cópia for feita durante a escrita, o arquivo pode sair inconsistente. Restaurar um `.db` junto com um `-wal` ou `-shm` de outro momento
pode corromper o banco. Por isso o backup usa uma das duas formas abaixo.

**Opção A: VolumeSnapshot** (se a classe de storage suportar snapshots, verifique com `oc get volumesnapshotclass`):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: signature-orchestrator-data-<data>
spec:
  volumeSnapshotClassName: <classe-de-snapshot>
  source:
    persistentVolumeClaimName: signature-orchestrator-data
```

O snapshot captura o volume inteiro (`.db`, `-wal` e `-shm` juntos). Tirado com o pod em uso, ele equivale a uma queda de energia:
o SQLite se recupera pelo WAL desde que os três arquivos sejam restaurados juntos. Para uma cópia sem dúvida, pare a aplicação antes
(`oc scale deploy/signature-orchestrator --replicas=0`) e suba de novo depois.

**Opção B: backup lógico com a API de backup do `better-sqlite3`.** O `sqlite3` CLI pode não existir na imagem (a runtime é minimal),
por isso a receita usa o próprio módulo instalado no contêiner. O backup vai para `/tmp`, e não para o volume:

```bash
oc exec deploy/signature-orchestrator -- node -e "const Database = require('better-sqlite3'); const db = new Database('/data/state/orchestrator.db'); db.backup('/tmp/orchestrator-backup.db').then(() => { db.close(); console.log('backup ok'); });"
POD=$(oc get pod -l app=signature-orchestrator -o jsonpath='{.items[0].metadata.name}')
oc cp "$POD:/tmp/orchestrator-backup.db" ./orchestrator-backup.db
oc exec "$POD" -- rm -f /tmp/orchestrator-backup.db
```

Guarde o arquivo em local restrito: ele contém dados pessoais.

**Restore (procedimento a validar em homologação antes de depender dele):**

1. Pare o único processo que usa o banco: `oc scale deploy/signature-orchestrator --replicas=0`.
2. Suba um pod temporário com a mesma imagem e o PVC montado (`restore.yaml`, fora do repositório):

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: restore-orchestrator
   spec:
     restartPolicy: Never
     containers:
       - name: restore
         image: <registry>/<namespace>/signature-orchestrator:<tag>
         command: ["sleep", "3600"]
         volumeMounts:
           - name: data
             mountPath: /data
     volumes:
       - name: data
         persistentVolumeClaim:
           claimName: signature-orchestrator-data
   ```

3. Troque o banco. Remova o `-wal` e o `-shm` antigos, porque pertencem ao banco substituído:

   ```bash
   oc apply -f restore.yaml
   oc wait --for=condition=Ready pod/restore-orchestrator --timeout=120s
   oc exec restore-orchestrator -- rm -f /data/state/orchestrator.db-wal /data/state/orchestrator.db-shm
   oc cp ./orchestrator-backup.db restore-orchestrator:/data/state/orchestrator.db
   oc delete pod restore-orchestrator
   ```

4. Suba a aplicação: `oc scale deploy/signature-orchestrator --replicas=1`, e confirme `SQLite ready` nos logs.

Para restaurar a partir de um VolumeSnapshot, crie um PVC com `dataSource` apontando para o snapshot e troque o `claimName` do deployment.

---

## 2. Passo a passo de aplicação

### 2.1 Namespace

```bash
oc new-project <namespace>      # ou: oc project <namespace>, se já existir
```

### 2.2 Secret

Os valores reais são informados pelo responsável da integração e não ficam neste repositório:

```bash
oc create secret generic signature-orchestrator-env \
  --from-literal=CLIENT_ID='<preencher>' \
  --from-literal=CLIENT_SECRET='<preencher>' \
  --from-literal=SIGNATURE_SECRET='<preencher>' \
  --from-literal=LOG_USER='<preencher>' \
  --from-literal=LOG_PASS='<preencher>' \
  --from-literal=OTCS_USER='<preencher>' \
  --from-literal=OTCS_PASS='<preencher>'
```

- Para não deixar senhas no histórico do shell, prefira `--from-env-file=<arquivo-fora-do-repo>` (linhas `CHAVE=valor`) e apague o arquivo depois.
- `START_AUTH_USER` e `START_AUTH_PASS` são opcionais (as duas ou nenhuma): Basic Auth próprio do `POST /auth`, a credencial
  embutida no WebReport (ver `webreports/README.md` e o README da pasta de cada WebReport). Sem elas vale `LOG_USER`/`LOG_PASS`. Acrescente-as com `--from-literal`.
- `ADOBE_REFRESH_TOKEN` é opcional: acrescente `--from-literal=ADOBE_REFRESH_TOKEN='<...>'` somente se for semear o token (ver seção 3).
- Se o Secret já existir, atualize-o com `oc create secret generic ... --dry-run=client -o yaml | oc apply -f -`.

### 2.3 Ajustar os arquivos antes de aplicar

- `configmap.yaml`: `PUBLIC_URL` deve ser `https://<host-da-rota>`, exatamente o host da Route.
- `route.yaml`: `host` (o mesmo de `PUBLIC_URL`).
- `deployment.yaml`: `image` (ver passo 2.5).
- `pvc.yaml`: `storageClassName`, conforme as seções 1.2 e 1.4.

### 2.4 Aplicar

```bash
oc apply -k deploy/openshift
```

Cria o PVC, o ConfigMap, o Deployment, o Service e a Route. O Secret não entra nessa aplicação.
**Não use `oc apply -f deploy/openshift/`**: ele também aplicaria `secret.example.yaml` e sobrescreveria o Secret real com os placeholders.

### 2.5 Build e envio da imagem

Rode a partir da **raiz** do repositório (o contexto de build é a raiz):

```bash
podman build -f deploy/openshift/Containerfile -t <registry>/<namespace>/signature-orchestrator:<tag> .
podman push <registry>/<namespace>/signature-orchestrator:<tag>
```

Use `docker` no lugar de `podman` se preferir. A imagem usa `ubi9/nodejs-22` no build e `ubi9/nodejs-22-minimal` no runtime, ambos com Node 22
(o `package.json` exige Node 20 ou mais novo).

**`better-sqlite3` é nativo.** O `npm ci` baixa um binário pré-compilado (prebuild) para a combinação Node/OS/arquitetura da imagem. Quando não
existe prebuild, o npm compila do código-fonte, e o estágio de build precisa de python3, make e g++. Verifique no log do build se o npm tentou
compilar; se faltarem essas ferramentas na imagem de build, prevê-las ali. O build precisa de acesso à internet para baixar o prebuild. Se o
registry ou o proxy bloquear o download, prevê um mirror ou aceitar a compilação a partir do código-fonte.
Build e runtime precisam ter o mesmo Node/OS/arquitetura, porque o `.node` compilado não é portável. Por isso a imagem final copia apenas o
`node_modules` do estágio de build, que tem a mesma base.

Enquanto a imagem não for enviada, o pod fica em `ImagePullBackOff`. Para evitar isso, faça o build e o push antes do passo 2.4.
Depois do push, `oc rollout restart deploy/signature-orchestrator` acelera a nova tentativa.

### 2.6 Verificação

```bash
oc get pvc signature-orchestrator-data                       # STATUS: Bound; ACCESS MODES: RWO
oc rollout status deploy/signature-orchestrator
oc logs deploy/signature-orchestrator | grep -E "SQLite ready|Server started"
oc logs deploy/signature-orchestrator | grep "\[STORAGE\]"   # não deve retornar nenhuma linha
curl -s https://<host-da-rota>/health                        # {"status":"ok"}
```

Esperado: `SQLite ready: /data/state/orchestrator.db (schema vN)` e `Server started successfully`. Não deve aparecer nenhuma linha com `[STORAGE]`.
Se aparecer, o `DATA_DIR` ou o PVC não estão corretos.

---

## 3. Pós-deploy: autorizar o Adobe e configurar o webhook

1. **Autorizar o Adobe uma vez.** Abra `<PUBLIC_URL>/admin/login` com Basic Auth (`LOG_USER`/`LOG_PASS`). O consentimento volta para
   `<PUBLIC_URL>/admin/callback`, que precisa estar cadastrado como redirect URI da aplicação no Adobe Sign. Os tokens ficam em
   `/data/state/tokens.json`, no PVC.
2. **Alternativa:** `ADOBE_REFRESH_TOKEN` no Secret. Ele só é usado quando o `tokens.json` não tem refresh token; um refresh token já salvo no arquivo tem precedência.
3. **Webhook:** cadastre no Adobe Sign a URL `<PUBLIC_URL>/webhook`, inscrita nos eventos de acordo.
4. Ao trocar o host (`PUBLIC_URL`), atualize no Adobe o redirect URI e a URL do webhook.
5. `WEBHOOK_REQUIRE_CLIENT_ID` fica em `false`. Ligue (`true`) só depois de confirmar que o header `X-AdobeSign-ClientId`
   dos POSTs está no conjunto `CLIENT_ID` + `WEBHOOK_CLIENT_IDS` (o webhook criado pela UI pode usar outro ClientId).

---

## 4. Atualização e rollback

- **Janela de indisponibilidade:** `Recreate` derruba o pod atual antes de subir o novo. São poucos segundos (start do Node e readiness).
  Nesse intervalo o orquestrador não responde 2xx ao Adobe. O Adobe reenvia as notificações não confirmadas, e o poller revisa os acordos sem
  resultado final quando o serviço volta. Essa indisponibilidade é aceitável para o fluxo.
- **Atualizar:** gere uma nova tag, envie a imagem e troque o `image` do `deployment.yaml` (mantendo o repositório sincronizado com o cluster),
  depois rode `oc apply -k deploy/openshift`. Alternativa sem editar o arquivo:
  `oc set image deploy/signature-orchestrator signature-orchestrator=<registry>/<namespace>/signature-orchestrator:<nova-tag>`.
- **Antes de atualizar**, faça o backup da seção 1.8 se a versão nova acrescentar uma migração de schema. O log de start mostra `schema vN`: compare o número com o da versão anterior.
- **Rollback:** `oc rollout undo deploy/signature-orchestrator` volta para a réplica anterior (imagem e configuração do pod). Os dados do PVC permanecem.
  O rollback **não desfaz migração de banco**. As migrações só são acrescentadas ao final (`PRAGMA user_version`), mas uma imagem antiga sobre
  um banco já migrado não é garantida. Por isso o backup vem antes. `ConfigMap` e `Secret` também não voltam sozinhos.

---

## 5. Operação

- `GET /health` (sem autenticação): usado pelas probes.
- `GET /admin/agreements[?state=needs_attention]` e `POST /admin/reconcile/:id` (Basic Auth `LOG_USER`/`LOG_PASS`): estado de cada acordo e reconciliação forçada.
  Acordos em `needs_attention` aparecem com `attentionReason`.
- `GET /logs` (Basic Auth): log de auditoria do dia. Os logs também saem na saída padrão: `oc logs deploy/signature-orchestrator`.
- Os arquivos diários de auditoria e de erro ficam em `/data/logs` (`oc exec deploy/signature-orchestrator -- ls -l /data/logs`).
