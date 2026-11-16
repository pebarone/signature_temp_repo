# Auditoria de idempotência, resiliência e concorrência

Auditoria de 06/11/2026 do orquestrador contra os problemas observados em produção com o integrador anterior. Este documento
não traz dados reais (IDs, nomes, e-mails): os testes citados usam só dados sintéticos.

Legenda de status:

- **Resolvido**: o código já tratava o problema e há teste.
- **Corrigido**: a lacuna foi corrigida nesta auditoria, com teste.
- **Aberto**: lacuna ou risco que continua, com o motivo.

As referências `arquivo:linha` são do working tree de 06/11. Os nomes de função são a referência estável.

Abreviações de arquivos:

- `RS` = `server/services/reconciliationService.js`
- `AS` = `server/domain/agreementState.js`
- `REPO` = `server/infra/agreementRepository.js`
- `SIG` = `server/services/signatureService.js`
- `OC` = `server/infra/otcsClient.js`
- `WH` = `server/http/routes/webhook.js`
- `T_*` = `test/*.test.js`, por exemplo `T_REC` = `test/reconciliation.test.js` e `T_RES` = `test/resilience.test.js`

## Resumo

| # | Problema | Status |
|---|---|---|
| 1 | Perda de estado no restart | Resolvido |
| 2 | Falha depois do 200 nunca refeita; erro permanente sem fim | Corrigido (limite de reaberturas) |
| 3 | Webhooks atrasados ou ausentes | Resolvido + corrigido (aviso de webhook inativo) |
| 4 | Entrega serial do Adobe (5 s) | Corrigido (adoção em 3 s, eco no 400/413) |
| 5 | PDF processado duas vezes (ACTION + WORKFLOW_COMPLETED) | Resolvido (testes acrescentados) |
| 6 | Firmado antes do PDF | Resolvido |
| 7 | `/start` duplicando acordos | Resolvido |
| 8 | `/start` sem token | Corrigido (503 na falha transitória, log de falha ao gravar) |
| 9 | Recuperação manual em massa | Corrigido (PDF igual não duplica; restante aceito por decisão) |
| 10 | Reenvios, cancelados e expirados | Resolvido, com risco residual |
| 11 | Documento errado no workspace | Resolvido, com risco residual |
| 12 | Rajadas | Corrigido (limite global, Retry-After, teste de carga) |
| 13 | Eventos fora de ordem e duplicados | Resolvido (testes acrescentados) |
| 14 | Corte de produção (~99 acordos) | Resolvido |
| 15 | Réplica única | Resolvido (documentado) |
| 16 | Observabilidade | Corrigido (e-mails mascarados, visão no admin) |

## Matriz

### 1. Perda de estado no restart

**Status:** Resolvido.

**Evidência:**

- SQLite em `DATA_DIR/state/orchestrator.db` (`server/config/index.js`), em WAL, com migrações v1–v8 (`server/infra/db.js`).
  Os tokens ficam em `DATA_DIR/state/tokens.json`. Com `REQUIRE_PERSISTENT_STORAGE=true`, o start aborta se o storage for
  efêmero.
- A fila é durável. O estado de cada etapa fica em colunas: `attempts`, `next_attempt_at`, `pdf_delivered`,
  `start_sendon_done`, `sendon_done` e `final_kind`. `runQueue` (RS:1193) as relê pelo poller depois do restart. Os
  timers em memória são só aceleração.
- O evento é gravado na mesma transação do patch (`recordEventTx`, REPO:174), antes do 200.
- Se o PDF subiu mas o banco não registrou: o marcador `Adobe Sign: <id>` na descrição da versão evita a segunda versão
  (`addVersionWithTicket`, OC).
- Se o PUT da disposição foi aplicado mas não registrado: o retry encontra a tarefa concluída e marca
  `completedExternally` (`executeDisposition`, RS:568).

**Testes:**

- `T_REC` "estado persistido sobrevive a restart (reabre o arquivo SQLite) e retoma só a disposição"
- `T_REC` "restart no meio: evento final persistido mas processamento não concluído é retomado pelo runQueue"
- `T_REC` "POLL_ENABLED=false: a fila de retries continua sendo revisada após o restart..."
- `T_WF` "resposta de SendOn perdida: restart retoma início e disposição sem repetir o PUT aplicado"
- `T_OTCS` "otcs.addVersion: resposta perdida após a escrita não duplica versão, inclusive com cliente novo"

**Risco residual:**

- Um Firmado aplicado e não registrado fica como `completedExternally`, sem `disposition`. O rótulo fica errado, mas o
  envio não se repete.
- No fluxo puro expirado, se o PUT se perde, o stop do workflow não é refeito.
- O shutdown não espera o trabalho em andamento; a retomada depende do `runQueue`.

### 2. Falha depois do 200 nunca refeita

**Status:** Corrigido.

**Evidência:**

- Toda falha passa por `registerFailure` (RS:149) e `failurePatch` (AS:214). O backoff vai de 1 min a 60 min, com
  `RETRY_MAX_ATTEMPTS=10`. Ao esgotar, o acordo vai para `needs_attention`/`retries_exhausted`.
- São permanentes, sem retry, só os erros de dado: workflow 404, falta de IDs, disposição inexistente e subprocesso
  ambíguo.
- **Lacuna corrigida:** `reopenStale` (RS:1210) reabria `retries_exhausted` a cada 6 h, sem limite. Um 403 de ACL ficava
  em ciclo eterno.
  - Agora a migração v8 cria `reopen_count`, e `ATTENTION_MAX_REOPENS` (padrão 3; 0 = sem limite) limita as reaberturas
    em `listAttentionToReopen` (REPO:105).
  - Ao atingir o limite, o motivo diz "no se reabrirá automáticamente... requiere intervención manual".
  - O `/admin/reconcile` manual e um novo evento final zeram o contador.
- O estado terminal pode ser consultado em `GET /admin/agreements?state=needs_attention` ou `?view=terminal`.

**Testes:**

- `T_REC` "M1: disposição com 403 até esgotar => retries_exhausted (não permanent) e reopenStale reabre depois de ATTENTION_RETRY_HOURS"
- `T_REC` "RETRY_MAX_ATTEMPTS: ao atingir o limite vai para needs_attention com o motivo e o último erro"
- `T_REC` "B7: exceção inesperada na reconciliação conta como falha (backoff)..."
- `T_RES`: testes do teto de reaberturas (403 permanente para no limite, reconcile manual zera, `ATTENTION_MAX_REOPENS=0`
  não limita, evento final zera)

**Risco residual:** alguns 4xx são na prática permanentes (attachId inválido → 400 no upload para a pasta), mas são
tratados como transitórios até o limite. Saem do ciclo depois de 4 rodadas, cerca de 40 h.

### 3. Webhooks atrasados ou ausentes

**Status:** Resolvido + corrigido.

**Evidência:**

- O polling escolhe os acordos pela linha no banco, não pelos eventos (`listPollable`, REPO:112). Um acordo sem nenhum
  evento, nem o CREATED, também é consultado.
- `shouldPoll` (AS:305): até `POLL_MAX_AGE_DAYS=90`, e depois até `expiresAt + 1 dia`. Não há corte de 72 h.
- `POLL_ENABLED` vale `true` no código (`server/config/index.js:160`) e em `deploy/openshift/base/configmap.yaml:22`. Os
  overlays de prod e de QA não o sobrescrevem.
- Sem webhook nenhum, o sistema converge pelo polling, em até `POLL_INTERVAL_MS` (10 min).
- **Corrigido:** quando o poller acha um resultado final de um acordo que nunca recebeu webhook, loga o warn "resultado
  final detectado sólo por polling: ningún webhook recibido... (¿webhook inactivo en Adobe?)" (`server/services/poller.js:28`).
  Esse é o sinal de que o Adobe desativou o webhook.

**Testes:**

- `T_REC` "poller recupera acordo SIGNED sem webhook"
- `T_REC` "poller: acordos além de POLL_MAX_AGE_DAYS deixam de ser consultados"
- `T_REC` "B5 poller: acordo com prazo (expiresAt) além de POLL_MAX_AGE_DAYS continua sendo consultado..."
- `T_RES`: testes do aviso do poller (com e sem webhook, e acordo em andamento)

**Risco residual:**

- O aviso é só de log, não há alerta.
- Num ambiente sem webhook configurado de propósito, como o QA local, todo acordo concluído gera esse aviso. Isso é
  esperado.
- Ficam fora do polling:
  - um acordo criado no Adobe que não chegou ao banco (crash entre o `createAgreement` e o `upsert`). Ele se recupera pelo
    reenvio do `/start`, que acha o acordo órfão, ou pela adoção;
  - acordos em `needs_attention` de tipo `event`;
  - acordos com mais de 90 dias e sem prazo.

### 4. Entrega serial do Adobe (prazo de 5 s)

**Status:** Corrigido.

**Evidência:**

- O acordo conhecido responde 200 depois do insert síncrono. O pipeline roda em segundo plano (`handleEvent`, RS:1054).
- **Corrigido:** a espera da adoção de acordo desconhecido caiu de 8 s para 3 s (`ADOPTION_WAIT_MS`, WH:16). Acima disso a
  resposta é 503 e o Adobe reenvia. A regra está em `docs/REGLAS_DEL_FLUJO.md` §7, junto com a importação legada no corte.
- **Corrigido:** o eco do `X-AdobeSign-ClientId` agora vale também nos erros do body-parser (JSON inválido → 400, corpo
  acima de 10 MB → 413). O middleware `webhookEchoClientId` (WH:37) é montado antes do `express.json` (`server/app.js:79`).
  HEAD, GET e os 200/401/400/500/503 da rota já ecoavam.
- O corpo é limitado a 10 MB. Um payload com `includeSignedDocuments` acima disso recebe 413, sem processar.

**Testes:**

- `T_HTTP` "webhook POST (B6): sem sobrescrever o limite, a adoção lenta responde 503 em até ~3 s..."
- `T_HTTP` "webhook POST: JSON inválido e corpo acima de 10 MB respondem com o eco do X-AdobeSign-ClientId (400 / 413)"
- `T_HTTP` "WEBHOOK_REQUIRE_CLIENT_ID=true: a recusa 401 também ecoa o X-AdobeSign-ClientId..."
- `T_HTTP` "webhook HEAD/GET: eco do X-AdobeSign-ClientId recebido..."

**Risco residual:**

- O `busy_timeout` do SQLite é de 5 s (`server/infra/db.js:137`). Ele só pesa com outro processo no mesmo banco, o que a
  réplica única impede (item 15).
- O 503 de adoção também segura a fila do Adobe enquanto ele retenta. A alternativa, responder 200 e adotar em segundo
  plano, foi avaliada e não adotada (`docs/REGLAS_DEL_FLUJO.md` §7).

### 5. PDF processado duas vezes (ACTION_COMPLETED + WORKFLOW_COMPLETED)

**Status:** Resolvido (testes acrescentados).

**Evidência:**

- O `ACTION_COMPLETED` só é final com `agreement.status === 'SIGNED'` no payload (`server/domain/eventPolicy.js`). Mesmo
  assim, `verifyFinal` (RS:403) confirma no Adobe antes do PDF. Com `OUT_FOR_SIGNATURE`, o acordo entra em retry, sem
  PDF.
- O pipeline é serializado por acordo (`enqueue`, RS:849), e `pdfDelivered`/`sendonDone` impedem uma segunda entrega.
- O marcador remoto na versão cobre um crash entre o upload e o registro.

**Testes:**

- `T_REC` "disposição é executada uma única vez (eventos repetidos, concorrência e reconcile manual)"
- `T_RES` "ACTION_COMPLETED SIGNED com o Adobe em OUT_FOR_SIGNATURE..." (sem PDF nem disposição, em retry)
- `T_RES` "fora de ordem: WORKFLOW_COMPLETED concluído e depois ACTION_COMPLETED tardio"
- `test/load.test.js` (pares ACTION + WORKFLOW embaralhados)

**Risco residual:** nenhum identificado.

### 6. Firmado antes do PDF

**Status:** Resolvido.

**Evidência:**

- Em `doReconcile` (RS:760), a ordem é `verifyFinal`, depois `deliverSignedPdf` (que retorna se falhar), depois
  `executeDisposition`. Nenhum caminho em segundo plano chega à disposição sem passar por `doReconcile`.
- O 403 no download do Adobe é retentado dentro da etapa do PDF, que bloqueia a disposição.

**Testes:**

- `T_REC` "PDF final é enviado ao OTCS ANTES da disposição"
- `T_REC` "falha no upload do PDF: não avança a tarefa e agenda retry com backoff"
- `T_REC` "falha no download do Adobe também agenda retry (nada é engolido)"

**Risco residual:** se o DocID não existe (404), o PDF vai para a pasta de anexos e a disposição segue. Esse é o
comportamento previsto.

### 7. `/start` criando acordos duplicados

**Status:** Resolvido.

**Evidência:**

- Uma chave em andamento por `nodeId|e-mails` e por `workflow|sub|node` (SIG:555). O check-and-add não tem `await` no
  meio, então é atômico no processo.
- Idempotência por workflow: o ciclo aberto responde 409 `PREVIOUS_CYCLE_OPEN`, e o acordo existente é devolvido.
- Falha parcial (acordo criado no Adobe e não gravado): o reenvio procura o acordo órfão pelo `externalId` determinístico
  (`findOrphanAgreement`, SIG:439) e o adota em vez de criar outro.

**Testes:**

- `T_HTTP` "/start: duas requisições concorrentes iguais => só uma cria o acordo..."
- `T_START` "/start: resposta do createAgreement perdida (timeout) => 500 e o reenvio reaproveita o acordo, sem duplicar"
- `T_START` "/start: acordo órfão em andamento (mesmo externalId e e-mails) é registrado em vez de criar outro"
- `test/load.test.js` (22 `/start` concorrentes mais repetições do mesmo fluxo: zero duplicados)

**Risco residual:**

- Com `START_VERIFY_WORKFLOW=false` (só no modo legado) não há busca de acordo órfão.
- A trava é em memória (item 15).

### 8. `/start` sem token

**Status:** Corrigido.

**Evidência:**

- O refresh do token é single-flight (`inflight`, `server/infra/tokenStore.js:124`) e é gravado em `tokens.json` com
  escrita atômica.
- **Corrigido:** uma falha transitória do refresh (rede, timeout, 5xx, 429) agora responde **503** "Adobe no disponible"
  ao WebReport. Antes respondia 401 `LOGIN_REQUIRED`. O 401 fica só para sessão perdida (`REFRESH_TOKEN_MISSING` ou
  400/401 do endpoint de token), em `adobeSessionLost` (SIG:90). Em nenhum dos dois casos há registro no banco nem
  reatribuição da tarefa.
- **Corrigido:** a falha ao gravar o token rotacionado agora é logada (`server/infra/tokenStore.js`), sem os valores.

**Testes:**

- `T_INFRA` "tokenStore: 10 ensureToken() concorrentes com token expirado => um único refresh e o mesmo token para todos"
- `T_INFRA` "tokenStore: refresh cujo tokens.json não pode ser gravado loga erro (sem valores de token)..."
- `T_START` "/start: refresh do token do Adobe com falha TRANSITÓRIA (rede, timeout, 5xx, 429) => 503 sem acordo; sessão perdida... => 401"
- `T_START` "/start em sub-workflow: falha TRANSITÓRIA do Adobe => 503 e a tarefa NÃO é reatribuída"

**Risco residual:** se a gravação falha depois de o Adobe rotacionar o refresh token, o token novo se perde no restart e é
preciso refazer o login. Agora isso fica no log.

### 9. Recuperação manual em massa

**Status:** Corrigido em parte.

**Evidência:**

- Uma "Aguardar Firma" já concluída por outra via é marcada `completedExternally`, sem erro, sem retry e sem um segundo
  Firmado (`executeDisposition`, RS:568).
- **Corrigido:** se a versão mais recente do DocID tem o mesmo tamanho do PDF assinado, o PDF é considerado já entregue e
  não se cria outra versão (OC:84). Isso cobre o caso de um operador ou o integrador antigo ter subido o mesmo PDF à mão,
  sem o marcador. Uma versão com o marcador de **outro** acordo nosso (ciclo anterior no mesmo DocID) nunca conta como
  entregue, mesmo com o mesmo tamanho.
- `T_OTCS` "otcs.addVersion: a versão mais recente com o mesmo tamanho mas com o marcador de OUTRO acordo => grava a nova versão"

**Testes:**

- `T_WF` "tarefa de firma já concluída fora da integração: conclui com completedExternally, sem disposição nem needs_attention"
- `T_REC` "B2 disposição: firma concluída e início também concluído... segue como conclusão externa"
- `T_OTCS` "otcs.addVersion: a versão mais recente com o mesmo tamanho (PDF enviado à mão, sem marcador) não gera outra versão"
- `T_OTCS` "otcs.addVersion: só vale a versão MAIS RECENTE (maior version_number)..."

**Decisão (Pedro, 08/11):** manter o comportamento atual. O PDF assinado continua sendo entregue mesmo com a tarefa
concluída à mão; uma versão a mais vinda de upload manual é responsabilidade do operador. A comparação fica só por
tamanho, sem hash.

**Risco residual (aceito):**

- Um PDF subido à mão com bytes diferentes (outro download, digitalização) gera uma nova versão. O teste de `T_WF`
  acima documenta que o PDF ainda é entregue quando a tarefa já foi concluída à mão.
- No fallback para a pasta, se o OTCS guardar o marcador só no nó e não na versão, um documento de outro acordo com
  exatamente o mesmo tamanho seria tomado como entregue. É muito improvável e não foi corrigido.

### 10. Reenvios, cancelados e expirados

**Status:** Resolvido, com risco residual.

**Evidência:**

- A correlação é só por ID. O webhook usa `repo.get(agreementId)`. A adoção exige o `externalId` com HMAC válido. O
  acordo órfão é casado por igualdade exata do `externalId`. O nome do documento nunca entra na correlação.
- Reenvio do mesmo workflow/sub/nó: com o ciclo aberto, 409 `PREVIOUS_CYCLE_OPEN`; com o ciclo concluído, abre um ciclo
  novo.
- Expirado, recall e falha de conversão dão `Rechazado`, nunca Firmado. O cancelamento feito pelo próprio integrador
  encerra sem disposição.

**Testes:**

- Tabela de política em `T_REC` (linhas de expirado, recall e conversão)
- `T_REC` "AGREEMENT_EXPIRED forjado com o Adobe em andamento: nenhuma disposição; retry com backoff"
- `T_START` "/start verificado: idempotência é por workflow + subprocesso + documento..."
- `T_WF` "webhook com externalId assinado copiado de um acordo real: não adota..."

**Risco residual:**

- A disposição localiza a tarefa pelo nome dentro do subprocesso, não pela instância da tarefa do acordo.
- Dois acordos abertos para nós diferentes no mesmo subprocesso poderiam concluir a tarefa um do outro. Não há teste.
  Hoje isso é improvável, porque cada subprocesso de firma tem um só documento.

### 11. Documento errado no workspace

**Status:** Resolvido, com risco residual.

**Evidência:**

- O upload vai para o `nodeId` (DocID) gravado no acordo no `/start`, que vem do OTCS e não do nome
  (`deliverSignedPdf`, RS:469).
- O PDF fica num Buffer em memória, sem arquivo temporário. A escrita atômica do `tokens.json` usa um nome único com pid
  e timestamp (`server/infra/util.js`).

**Testes:**

- `T_WF` "PDF assinado vira nova versão do nodeId; a pasta de anexos só é usada no fallback (nó 404)"
- `T_REC` "M1: addVersion 400 em nó inexistente/inacessível => sonda, fallback para a pasta e conclusão..."

**Risco residual:**

- No fallback, quando o DocID não existe, o upload procura na pasta de anexos **do próprio workflow** (AttachID) um
  documento com o mesmo nome e acrescenta uma versão a ele (OC, `uploadToFolder`).
- A pasta é correlacionada por ID, então o risco de ser de outra pessoa é baixo. Não foi alterado.

### 12. Rajadas

**Status:** Corrigido.

**Evidência:**

- **Corrigido:** há um limite global de pipelines simultâneos, `RECONCILE_CONCURRENCY` (padrão 4). O semáforo FIFO
  `createLimiter` (RS:42) envolve o `doReconcile`. Um acordo em hold de cancelamento não ocupa vaga.
- **Corrigido:** um 429 ou 503 com `Retry-After` (em segundos ou como data HTTP) adia o retry para
  `max(backoff, Retry-After)`, com teto de 60 min (`retryAfterMs`, AS:188).
- O ticket do OTCS (`server/infra/otcsClient.js:28`) e o token do Adobe (`server/infra/tokenStore.js:124`) são
  single-flight.
- Os erros transitórios do OTCS seguem o backoff do pipeline. Um 401 refaz o login uma vez.

**Testes:**

- `T_RES` "concorrência: 10 acordos com limite 3..." (pico ≤ 3; uma versão e uma disposição por acordo)
- `T_RES`: testes de Retry-After (segundos, data, teto, valor menor que o backoff, 5xx sem o header)
- `T_INFRA` "tokenStore: 10 ensureToken() concorrentes..."
- `test/load.test.js`, cenário:
  - 22 `/start` concorrentes mais repetições do mesmo fluxo;
  - 44 eventos ACTION + WORKFLOW_COMPLETED embaralhados, mais 10 reentregas.
- `test/load.test.js`, o que confere:
  - zero acordos duplicados;
  - uma versão e um Firmado por workflow;
  - todos os webhooks com 200 em menos de 1 s;
  - pico de pipelines ≤ o limite.

**Risco residual:**

- A adoção do webhook (`getAgreement`) e o `/start` não passam pelo limite.
- O retry interno do download 403 do Adobe pode ocupar uma vaga por até cerca de 2 min.
- O `/admin/reconcile` manual entra na mesma fila FIFO. Numa rajada, a requisição HTTP pode estourar o tempo enquanto a
  reconciliação segue em segundo plano.
- O hold de cancelamento não espera execuções ainda paradas na fila: elas devolvem `held` quando ganham a vaga.

### 13. Eventos fora de ordem e duplicados

**Status:** Resolvido (testes acrescentados).

**Evidência:**

- `agreement_events.notification_id UNIQUE` com `INSERT OR IGNORE` (`server/infra/db.js:45`, REPO:139). O duplicado não
  aplica patch.
- `finalPatch` (AS:43) não regride um acordo com `sendonDone`. Eventos informativos (CREATED, etc.) não mudam o estado.

**Testes:**

- `T_REC` "dedupe de webhook por webhookNotificationId"
- `T_REC` "eventos informativos/vermelhos não alteram o estado do acordo"
- `T_RES` "fora de ordem: final antes do AGREEMENT_CREATED"
- `T_RES` "fora de ordem: WORKFLOW_COMPLETED concluído e depois ACTION_COMPLETED tardio"
- `T_RES` "dedupe: mesmo notificationId grava um só evento"

**Risco residual:**

- O dedupe guarda os últimos 50 eventos por acordo. Um replay depois da poda é reaplicado, mas os guardas de estado o
  tornam inócuo.
- Eventos sem `notificationId` não são deduplicados, o que só gera ruído.

### 14. Corte de produção (~99 acordos)

**Status:** Resolvido.

**Evidência:**

- `importLegacyAgreements` (`server/infra/legacyImport.js`) pula IDs que já existem e renomeia o arquivo para
  `.migrated`, então rodar duas vezes não importa nada. Um arquivo corrompido vira `.corrupt` sem derrubar o start.
- A adoção é single-flight por acordo (`ensureAdopted`, RS:965) e confere de novo `repo.has` antes de gravar.
- O passo do corte (importar o `agreements.json` antes de virar o tráfego) está em `docs/REGLAS_DEL_FLUJO.md` §7 e em
  `deploy/openshift/README.md`.

**Testes:**

- `test/legacyImport.test.js` "não sobrescreve ids existentes e é idempotente"
- `T_WF` "webhook de acordo desconhecido com externalId nosso: adota (adopted=true) e reaplica o evento" (dois webhooks
  simultâneos dão uma só consulta e um só registro)
- `T_HTTP` "webhook POST (B6): adoção que demora além do limite => 503..."

**Risco residual:** os acordos do integrador antigo não têm o `sig` no `externalId`. Sem a importação, os eventos deles são
recusados e se perdem. A importação antes do corte é obrigatória.

### 15. Réplica única

**Status:** Resolvido (documentado).

**Evidência:**

- `deploy/openshift/base/deployment.yaml` tem `replicas: 1` e `strategy: Recreate`. Nenhum overlay muda isso.
- O motivo está em `deploy/openshift/README.md`, "Resumo do storage": o SQLite em WAL e as travas em memória (fila por
  acordo, limite global, `/start`, adoção, token, ticket, OAuth).

**Testes:** não se aplica (configuração de deploy).

**Risco residual:**

- Mover as travas para o banco (lease por acordo e índice único no `/start`) não foi feito, porque não é barato: a janela
  do `/start` cobre a chamada ao Adobe.
- O `check.sh` não confere `replicas`.

### 16. Observabilidade

**Status:** Corrigido.

**Evidência:**

- `agreement_events.received_at` guarda o horário de recepção. O `eventDate` do Adobe vai separado no `payload_summary`.
- Os segredos ficam fora do log. `describeError` não inclui cabeçalhos, corpo nem query da requisição, e o start não
  imprime a config.
- **Corrigido:** os e-mails saem mascarados (`ab***@dominio`) nos logs do webhook (Participant), do `/start`
  (Recipients) e dos avisos de divergência (`maskEmail`, `server/infra/util.js:55`). Os dados gravados e as respostas da
  API não mudam.
- **Corrigido:** `GET /admin/agreements` traz um `summary` e aceita `?view=` (`server/http/routes/admin.js:89`). O resumo
  conta:
  - `signedNotConcluded`: assinado, sem Firmado no OT;
  - `retrying`: em retry;
  - `terminal`: por `attentionKind`.

**Testes:**

- `T_INFRA` "util: maskEmail mantém as 2 primeiras letras do nome e o domínio..."
- `T_HTTP` "logs: e-mail do participante do webhook e destinatários do /start saem mascarados, nunca inteiros"
- `T_HTTP` "admin: GET /admin/agreements traz o resumo operacional (summary) e filtra por ?view=..."
- `T_INFRA` "util: escrita atômica não deixa temporários e describeError não vaza cabeçalhos" (falha só no Windows, por
  permissões)

**Risco residual:**

- `describeError` inclui até 500 caracteres do corpo da resposta do Adobe ou do OTCS, que pode conter um e-mail.
- O `eventDate` do Adobe não é coluna própria.
- Não há métrica nem alerta, só log e a rota do admin.

## Validação

- Suíte completa (`node --test`, Node 22.18, cópia fora do repo): **530 testes, 526 passam, 4 falham**. As 4 são as
  falhas conhecidas, que só ocorrem no Windows:
  - `storage: DATA_DIR explícito vence sempre`
  - `storage: subpastas logs/ inprocess/ state/ e arquivos`
  - `util: escrita atômica...`
  - `tokenStore: refresh grava tokens.json (modo 600)...`

  Nenhuma regressão. A base antes da auditoria tinha 490 testes.
- `test/resilience.test.js` e `test/cancellation.test.js` rodaram 3 vezes seguidas sem instabilidade.
- Nota da revisão: os dois testes de hold com o acordo parado no limite usam `sleep(10)` para supor que ele já está na
  fila. Se não estiver, passam pela checagem anterior do hold. O resultado é o mesmo (`held`), mas a prova do caminho
  dentro do limite é mais fraca.

## Arquivos alterados nesta auditoria

- **Código:**
  - `server/services/reconciliationService.js`
  - `server/domain/agreementState.js`
  - `server/infra/agreementRepository.js`
  - `server/infra/db.js` (migração v8)
  - `server/config/index.js`
  - `server/services/poller.js`
  - `server/app.js`
  - `server/http/routes/webhook.js`
  - `server/http/routes/start.js`
  - `server/http/routes/admin.js`
  - `server/services/signatureService.js`
  - `server/infra/tokenStore.js`
  - `server/infra/otcsClient.js`
  - `server/infra/util.js`
- **Testes:**
  - `test/resilience.test.js` (novo)
  - `test/load.test.js` (novo)
  - `test/http.test.js`
  - `test/start.test.js`
  - `test/infra.test.js`
  - `test/otcsModel.test.js`
  - `test/cancellation.test.js` (contagem de migrações)
- **Docs e deploy:**
  - `docs/REGLAS_DEL_FLUJO.md` §7 e §9
  - `docs/DESIGN_TICKET_2026060410003715.md` (espera do `settle`)
  - `deploy/openshift/README.md`
  - `deploy/openshift/base/deployment.yaml` (comentário)
  - este arquivo

Novas variáveis de ambiente:

- `ATTENTION_MAX_REOPENS`, padrão `3`
- `RECONCILE_CONCURRENCY`, padrão `4`
