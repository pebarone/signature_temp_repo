# Regras do fluxo — Adobe Sign ↔ OpenText Content Server

Complementa `DESIGN_TICKET_2026062210004476.md` (decisões de arquitetura). Este documento descreve **o que o orquestrador
faz** em cada situação, para operação e suporte. Fatos sobre o Content Server vêm de consultas GET ao QA; o que ainda
não foi validado está marcado como tal.

## 1. Visão geral

```
WebReport (tarefa 2) --POST /start--> cria acordo no Adobe (externalId) + grava no SQLite (start_sendon_done=false)
                                         |
                                         v   etapa START (background, com retry)
                       SendOn da tarefa de início  -->  tarefa "Aguardar Firma" fica ativa
                                         |
          Adobe: webhook / polling --> resultado final (assinado, recusado, expirado, cancelado...)
                                         |
                                         v   etapas persistidas e idempotentes
            VERIFY (resultado final confirmado no Adobe) -> PDF (nova versão do documento) -> DISPOSITION (Firmado/Rechazado)
```

Cada etapa só roda se a anterior concluiu, grava seu resultado no SQLite e, se falhar, agenda retry com backoff
(1 min … 1 h). Reprocessar nunca repete uma etapa já concluída (`start_sendon_done`, `pdf_delivered`, `sendon_done`).

## 2. Evento/estado Adobe → resultado → disposição → atributos

| Evento (webhook) ou estado (polling) | Resultado | PDF | Disposição (config) | Estado final | Atributos do workflow\* |
|---|---|---|---|---|---|
| `AGREEMENT_WORKFLOW_COMPLETED`; `AGREEMENT_ACTION_COMPLETED` com `status=SIGNED`; polling `SIGNED` | final OK (exige `SIGNED` confirmado no Adobe) | sim: nova versão do `nodeId` | `DISPOSITION_SIGNED` = `Firmado` | `completed` | estado Adobe `SIGNED`, integração `pdf_delivered` antes da disposição |
| `AGREEMENT_REJECTED`; polling `CANCELLED` + evento `REJECTED`/`ACTION_REJECTED` | recusado | não | `DISPOSITION_REJECTED` = `Rechazado` | `rejected` | idem |
| `AGREEMENT_EXPIRED`; polling `EXPIRED` | expirado (prazo `DUE_DATE` vencido; seção 4.5) | não | `DISPOSITION_EXPIRED` = `Rechazado`, com o comentário de caducidad; no fluxo puro, depois **stop do fluxo** (`EXPIRED_STOP_WORKFLOW`); no subfluxo só a firma é cancelada | `expired` | idem |
| `AGREEMENT_RECALLED`; polling `CANCELLED` sem recusa | cancelado | não | `DISPOSITION_RECALLED` = `Rechazado` (**exceto** acordo já encerrado por pedido de cancelamento: sem disposição, seção 10) | `cancelled` | idem |
| `AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM`; polling `ABORTED` com o evento `AUTO_CANCELLED_CONVERSION_PROBLEM` (seção 4.2) | falha de conversão | não | `DISPOSITION_CONVERSION_FAILED` = `Rechazado` | `cancelled` | idem |
| `AGREEMENT_DOCUMENTS_DELETED`; polling `ABORTED` sem o evento de conversão | exige intervenção | não | nenhuma | `needs_attention` (`event`) | integração `needs_attention` |
| `AGREEMENT_ACTION_COMPLETED` com status em andamento; informativos (`CREATED`, `ACTION_REQUESTED`, `MODIFIED`, `EMAIL_VIEWED`, `REMINDER_SENT`...) | progresso/histórico | não | nenhuma | `pending` | estado Adobe atualizado se o polling o viu mudar |
| indisponíveis (`VAULTED`, `KBA_AUTHENTICATED`, `WEB_IDENTITY_AUTHENTICATED`) e desconhecidos | ignorados (desconhecido gera warn) | não | nenhuma | sem mudança | — |

\* Só com `WF_ATTRIBUTES_ENABLED=true` (seção 8). Disposição **vazia** na config ⇒ `needs_attention` (`config`) em vez de
executar. Os mapas verificados só têm as ações `Firmado` e `Rechazado` na tarefa de firma, por isso os três últimos
resultados encerram o fluxo como `Rechazado` (o comentário da tarefa diz o motivo real, ver seção 4.4).
Todo resultado final desta tabela é confirmado no Adobe antes do PDF e da disposição (seção 4.2): se o Adobe disser
outro resultado final, vale o dele.

Comentário gravado na tarefa: `Firmado en Adobe Sign (acuerdo <id>)`, `Rechazado por el firmante en Adobe Sign`,
`Acuerdo expirado en Adobe Sign` (com `EXPIRED_STOP_WORKFLOW=true`, o padrão: `Firma cancelada por caducidad: el acuerdo <id> expiró en
Adobe Sign sin ser firmado`), `Acuerdo cancelado en Adobe Sign`, `Adobe Sign no pudo procesar el documento`.

## 3. Máquina de estados

Estados persistidos (`state`): `pending`, `signed`, `pdf_delivered`, `completed`, `rejected`, `expired`, `cancelled`,
`needs_attention`.

```
pending --(final OK)--> signed --(PDF entregue)--> pdf_delivered --(disposição)--> completed
pending --(recusado | expirado | cancelado)--> rejected | expired | cancelled   [sendon_done=1 quando a disposição vai]
qualquer estado aberto --(erro de dado | tentativas esgotadas | config | não confirmado | evento)--> needs_attention
needs_attention --(POST /admin/reconcile/:id | reabertura automática | novo evento final)--> estado aberto
qualquer estado aberto --(pedido de cancelamento confirmado no Adobe, seção 10)--> cancelled   [sendon_done=1, sem disposição]
```

Campos que acompanham: `start_sendon_done` (pedido de firma enviado), `pdf_delivered`/`pdf_node_id` (PDF gravado e nó que o
recebeu), `sendon_done`/`disposition` (tarefa concluída pela integração), `completed_externally` (tarefa já concluída
fora da integração), `sign_subprocess_id`/`sign_task_id` (tarefa de firma resolvida), `attention_kind`, `adopted`,
`expires_at` (migração v6; prazo do acordo no Adobe, ISO; `NULL` = desconhecido, seção 4.5), `cancel_requested_at`/`cancel_source`
(acordo encerrado por pedido de cancelamento, seção 10).

## 4. Etapas

### 4.1 start — envio do pedido de firma
- Ordem do WebReport: **acordo → reatribuição → SendOn**. A regra é: só reatribuir com acordo gerado; com o acordo gerado, o
  SendOn pode sair. A página chama o `/start` primeiro; só depois que ele confirma o acordo no Adobe a própria página (na sessão
  do usuário humano) reatribui a tarefa ao usuário de integração (`WFTASKACTION:REASSIGN`); o SendOn é do servidor, em
  background. Se o envio falha ou a página fecha, a tarefa continua na caixa do usuário e ele pode repetir. Nunca deixar a
  tarefa com o usuário de integração sem acordo, se der para evitar. Os dois WebReports (fluxo puro e Contratación) seguem
  esta ordem; o antigo de Contratación (REASSIGN na renderização, antes de qualquer acordo) continua funcionando (tarefa já
  atribuída → caminho do formulário → SendOn imediato), mas não respeita a regra.
- **Validação do PDF (antes do Adobe).** Depois de baixar o `DocID` e antes de criar o documento transitório, o conteúdo
  precisa ter `%PDF-` nos primeiros 1024 bytes (a especificação do PDF tolera lixo antes do cabeçalho; função pura em
  `domain/documentType.js`). Senão: `422 { error: "El documento a firmar no es un PDF válido.", code: "NOT_PDF" }`, **nada** é criado
  no Adobe e a tarefa não é tocada; o log `warn` (espanhol) traz nodeId, tamanho e o tipo detectado por sniff simples (HTML,
  ZIP/Office, texto, vacío, desconocido), nunca o conteúdo. Sem isso o Adobe aceitaria os bytes como `application/pdf` e só
  cancelaria o acordo depois, por problema de conversão. O usuário pode subir uma versão PDF no mesmo nó e repetir.
- O `/start` só cria o acordo (com `externalId`), grava o registro com `start_sendon_done=false` e dispara a etapa em
  background; responde sem esperá-la.
- Origem dos atributos (`DocID`, `AttachID`, nome, e-mails), conforme quem está com a tarefa de início
  (`task_assignees` de `status/processes/{id}` × `GET /v1/auth`):
  - atribuída ao usuário de integração → formulário da tarefa (como sempre; 401/403 → `409`);
  - com o usuário humano + **fluxo puro** (`subprocessId == processId`) → `GET /v2/workflows/status/info?workid={id}`
    (rótulos = `START_FIELD_*`; o mesmo conjunto de validações 422/409);
  - com o usuário humano + **sub-workflow** → `409` `REASSIGN_REQUIRED` (o `status/info` só devolve os atributos do
    **pai**, e o formulário exige a tarefa no usuário de integração): a página reatribui antes e repete o `/start`
    (com novo `/auth`: o nonce é de uso único). Antes de pedir a reatribuição há a **pré-checagem** (abaixo). Se, depois de
    reatribuir, o segundo `/start` falhar sem acordo, a página do fluxo puro devolve a tarefa ao usuário (ramo `accion=devolver`;
    ver `webreports/README.md`), porque o servidor nunca revisita uma tarefa que ficou com o usuário de integração sem acordo.
  - `task_assignees` ausente na resposta do OTCS → trata como atribuída (caminho antigo), sem consultar `GET /v1/auth`
    (`handoff.integrationUserId` vem `null`; o SendOn é tentado direto).
- A resposta do `/start` leva `handoff` = `{ workflowId, subworkflowId, taskId, integrationUserId, assigned }` (números):
  o que a página deve reatribuir quando `assigned=false`. Também vem no `existing: true` enquanto a tarefa de início
  ainda está `current`; com ela já avançada, `handoff` é omitido (nada a reatribuir). Sem `START_VERIFY_WORKFLOW`, não há `handoff`.
- **Pré-checagem do sub-workflow (antes do `REASSIGN_REQUIRED`).** Aqui o servidor não consegue ler o formulário (só quem tem a
  tarefa o lê) e, por isso, hoje pede a reatribuição **antes** de existir acordo. Para não reatribuir à toa, confere primeiro o
  **login do Adobe** (com ou sem dicas): sem sessão devolve `401` `LOGIN_REQUIRED` e não pede a reatribuição. Em seguida usa os valores do
  corpo, que aqui são só **dicas** (nunca usadas para criar acordo): se houver `nodeId` numérico e ao menos um e-mail, confere o
  `attachId` da dica (se veio preenchido, precisa ser numérico; senão o mesmo `422` do formulário, "El flujo no tiene la carpeta de
  destino (AttachID).", e `attachId` vazio nas dicas segue como antes), baixa o nó, roda a validação de PDF e a trava de duplicidade
  (abaixo). Se algo falhar, devolve o erro (`422` do AttachID, `NOT_PDF`, `DUPLICATE_OPEN`, ou o 500
  genérico se o OTCS falhar ao baixar) e **não** pede a reatribuição. Sem dicas, ou se o fluxo já tem acordo **deste ciclo** desse documento (não
  concluído e com o SendOn de início ainda pendente; o `/start` seguinte o devolve como `existing`), segue direto para o
  `REASSIGN_REQUIRED`. Se o acordo mais recente não está concluído mas o SendOn de início dele **já foi feito**, é de um ciclo
  anterior ainda aberto: `409 PREVIOUS_CYCLE_OPEN` (abaixo) e a tarefa **não** é reatribuída. Um acordo **concluído** é de um ciclo
  anterior já encerrado: a pré-checagem roda normalmente. Depois da reatribuição, o caminho normal
  relê o formulário (a fonte da verdade) e valida tudo de novo. Custo: um download extra do documento por abertura da página.
  - **Pendência (não validada):** a ordem estrita "acordo antes de reatribuir" no sub-fluxo depende de uma forma de ler os
    atributos do sub-fluxo **sem ser o responsável pela tarefa**. A candidata é `GET /v2/workflows/status/info?workid=<subworkid>`
    (com o ID do subprocesso no lugar do pai): no QA (29/10/2026, sub-fluxo 12353419) ela responde **400**, então não serve.
    Enquanto isso, a pré-checagem com as dicas é a
    mitigação: o dado que ela confere pode divergir do formulário, mas a validação definitiva roda depois da reatribuição.
- **O mesmo fluxo vê o acordo do ciclo dele, mesmo se já for final.** Com a validação do OTCS, o `/start` procura o acordo **mais
  recente** de (`workflowId`, `subworkflowId`, `nodeId`) (`findLatestByWorkflow`):
  - tarefa de início `current`: vale o acordo **deste ciclo**, isto é, o mais recente que não foi concluído (`sendonDone=false`): aberto,
    ou final com o resultado ainda não aplicado ao fluxo (o caso do incidente de QA). **Exceção, ciclo novo:** se o mais recente está
    **concluído** (`sendonDone=true`, inclusive `completedExternally`), o resultado já foi aplicado e o mapa voltou ao passo de envio
    (ex.: `Rechazado` com retorno ao envio, mesmo `DocID`); o acordo antigo é ignorado e o envio segue normal, criando um acordo novo,
    com a trava de duplicidade e a validação do PDF valendo como sempre;
  - **Exceção, ciclo anterior ainda aberto (`PREVIOUS_CYCLE_OPEN`).** Com a tarefa de início `current`, o acordo não concluído só é
    deste ciclo se o SendOn de início dele ainda está pendente (`start_sendon_done=false`: recarga enquanto a página reatribui). Se
    esse SendOn **já foi feito** (`start_sendon_done=true`) e o acordo segue sem concluir (aberto, ou final com a disposição ainda
    pendente), o fluxo avançou e voltou ao passo de envio: responder sucesso (`existing`) faria a página mostrar "enviado" com o fluxo
    parado em "Enviar", e criar outro acordo duplicaria o anterior. O `/start` responde
    `409 { error: "Este flujo tiene la solicitud de firma <id> de un envío anterior, aún sin concluir; cancélela o espere su resultado antes de reenviar.", code: "PREVIOUS_CYCLE_OPEN", id }`,
    sem acordo novo, sem SendOn, **sem `handoff`** (a tarefa não é reatribuída) e com um `warn` no log. Vale no caminho do
    formulário, no do fluxo puro com a tarefa no usuário humano e na pré-checagem do sub-workflow. Para liberar o envio: cancelar o
    acordo antigo (cancelamento de fluxos / Adobe) ou esperar o resultado dele ser aplicado.
    **Corrida com o background:** se o SendOn de início foi feito DURANTE o próprio `/start` (o retry em background grava
    `start_sendon_at` depois do instante em que o `/start` leu o `step_list`, com a tarefa ainda `current`), é o envio deste ciclo, não
    de um anterior: o `/start` responde `existing` **sem `handoff`** (nada a reatribuir), nunca um 409 falso;
  - tarefa de início já fora de `current` (recarga depois do SendOn): o mais recente em qualquer estado, inclusive concluído
    (nunca `PREVIOUS_CYCLE_OPEN`).

  Se existe um acordo (nesses casos):
  - aberto (sem resultado final e sem a disposição enviada): `200 { message: "Signature already requested. ID: ...", id, existing: true, handoff? }`;
  - já final ou concluído: `200 { message, id, existing: true, final: { kind, state, message }, handoff? }`, em vez do 409. `final.message`
    (espanhol, e também a `message` da resposta) diz o resultado por `kind`: `final_ok` já firmado; `final_rejected` o firmante rechazó;
    `final_expired` expirou; `final_recalled` cancelado no Adobe; `final_conversion_failed` "Adobe Sign no pudo procesar el documento
    (verifique que sea un PDF válido)"; mais a frase "El flujo continuará automáticamente según el resultado." (ou "ya continuó..." se
    a disposição já foi enviada, ou "requiere revisión del administrador" se o acordo está em `needs_attention`).
  - O `handoff` segue valendo (o acordo existe: a página pode reatribuir) e o kick continua: acordo com a etapa start pendente
    → `resumeStart` → `reconcile`, que com o resultado final faz o SendOn pendente da tarefa de início e depois a disposição.
- **Trava anti-duplicidade (15 min).** Só bloqueia um acordo **aberto** (sem resultado final e sem a disposição enviada) com o mesmo
  `DocID` e o mesmo **conjunto** de e-mails (sem caixa nem ordem), criado dentro da janela, em **outro** workflow/subprocesso:
  `409 { error: "Este documento ya tiene una solicitud de firma abierta para este destinatario en otro flujo.", code: "DUPLICATE_OPEN", id, workflowId }`
  (`id` e `workflowId` são os do acordo aberto). Acordo final ou concluído **nunca** bloqueia. Sem a validação do workflow
  (caminho legado, sem identidade de fluxo) vale só o critério "aberto". Uma requisição igual ainda em processamento neste servidor
  responde `409 { code: "START_IN_PROGRESS" }` (outra mensagem: o acordo dela ainda não existe).
- **Janela do acordo órfão.** Entre o `createAgreement` no Adobe e a gravação do registro (`repo.upsert`) o acordo só existe no
  Adobe. O `/start` registra o ID no log (`info`, com workflow/subprocesso/nó) **antes** de gravar; se a gravação falhar, loga um
  `error` em espanhol com o ID ("El acuerdo <id> se creó en Adobe pero no se pudo registrar ... Adóptelo con POST /admin/adopt/<id>")
  e responde o 500 genérico. Recuperação: `POST /admin/adopt/:id`.
- Repetir o `/start` (`existing: true`) com a etapa start ainda pendente retoma a reconciliação do acordo na hora
  (`resumeStart`: ignora o backoff e reabre um `needs_attention` `retries_exhausted`), então o SendOn sai logo após o
  REASSIGN da página. A reconciliação é serializada por acordo; repetir é seguro.
- A etapa consulta `GET /v2/workflows/status/processes/{workflowId}` e localiza a tarefa por `START_TASK_NAMES`:
  - `current` e atribuída ao usuário de integração → (opcional: grava os atributos) → SendOn com
    `processId/subprocessId/taskId` resolvidos → `start_sendon_done=true`.
  - `current` mas ainda atribuída ao usuário (a página não reatribuiu) → **não** tenta SendOn: estado transitório
    "aguardando reatribuição" (`status: waiting_handoff`), sem log de erro; conta como tentativa da etapa start e
    reagenda com o backoff normal (1 min, 2 min, 4 min…). Esgotado `RETRY_MAX_ATTEMPTS`, `needs_attention`
    (`retries_exhausted`) com o motivo "la tarea de envío (N) sigue asignada al usuario; reabra la página para completar el
    envío". Reabre sozinho após `ATTENTION_RETRY_HOURS` ou ao repetir o `/start` da página.
  - já `completed`, ou a tarefa de firma já está `current/completed` → só marca como feito (nada é enviado).
  - não encontrada / SendOn com erro → retry com backoff (o WebReport pode ainda estar ocupando a tarefa).
  - tarefa de início só em outro subprocesso → retry, com os ids na mensagem (seção 6).
  - tarefa existente em mais de um subprocesso e o acordo não indica qual → `needs_attention` permanente (seção 6).
  - processo inexistente (404) → `needs_attention` permanente; qualquer outro erro ao ler o processo → retry.
- Registros com `start_sendon_done=0` e `workflow_id` entram em `listPending`, então o `runQueue`/poller os retoma após restart.

### 4.2 verify
Todo resultado final (webhook ou polling) é confirmado no Adobe por `GET /agreements/{id}` antes do PDF e da disposição:
o `agreement.status` do payload não basta. Um `adobeStatus` já gravado por consulta ao Adobe que confirma o resultado
dispensa nova consulta (é o caso do polling). Em `CANCELLED` e `ABORTED` também se consulta `GET /agreements/{id}/events`:
em `CANCELLED`, recusa x recall; em `ABORTED`, o evento `AUTO_CANCELLED_CONVERSION_PROBLEM` é falha de conversão e, sem ele,
intervenção (`needs_attention`, `event`, no polling). Para confirmar uma falha de conversão vinda do webhook, `CANCELLED` (com ou
sem recusa) e `ABORTED` valem com ou sem o evento, porque o status não informa o motivo. Falha ao ler os eventos não finaliza:
no polling o próximo ciclo tenta de novo; no verify, retry com backoff. Confirmado ⇒ segue e grava `adobeStatus`. Estado em
andamento é **transitório** (retry com backoff).
Outro resultado final no Adobe (ex.: webhook `REJECTED` com Adobe `SIGNED`, ou `RECALLED` com evento de recusa) ⇒ **vale o
do Adobe**: grava-se o evento `VERIFY_STATUS_<status>` (`source=verify`), registra-se um warn e o pipeline roda de novo, uma
única vez. Sem resultado final no Adobe (`NEEDS_ATTENTION`, `UNKNOWN`, vazio) ⇒ `needs_attention` (`unconfirmed`); o final
OK não adota outro resultado. Se o PDF já foi entregue e a troca não pode ser aplicada ⇒ `needs_attention` (`unconfirmed`).
Um webhook que troca o resultado já gravado (ex.: `RECALLED` do polling e `REJECTED` do webhook) zera o `adobeStatus`
gravado, para que o verify consulte o Adobe (com os eventos) de novo. Com o mesmo resultado, o `adobeStatus` é mantido e
não há consulta extra.

### 4.3 pdf
Baixa `combinedDocument?attachAuditReport=true` e grava como **nova versão do `nodeId`** (o `DocID` do fluxo: é o nó que o
fluxo devolve ao pai e que a distribuição ao workspace copia). Se o nó não existe mais (sonda abaixo: 400/404), cai para
`uploadToFolder(attachId)`; sem `attachId` → `needs_attention`. Falha no `addVersion`:
- 404 → fallback direto para a pasta;
- 5xx, rede, 401/408/429 → retry com backoff (sem fallback);
- outro 4xx (400, 403, 409, 423…; a spec do OTCS documenta **400**, não 404, para nó inexistente ou sem acesso) → a
  integração **sonda o nó** (`GET /v1/nodes/{id}`): **400/404** = inexistente → fallback para a pasta; **existe** (200, ou
  **403**, que é o nó sem permissão para o usuário de integração) → retry com backoff, **sem** fallback, para o PDF não ir à
  pasta (`el documento N existe pero rechazó la nueva versión…; puede estar reservado o sin permiso`); sonda com erro
  (5xx/rede) → retry, sem fallback.

Falha no `uploadToFolder` (qualquer status) também é retry. Esgotadas as tentativas → `needs_attention`
`retries_exhausted` (reabre sozinho, seção 5).

A descrição da versão recebe `Adobe Sign: <agreementId>`; a entrega consulta as versões antes de escrever. No fallback,
um novo nó recebe esse marcador na sua descrição; se já existe um nó com o mesmo nome, a versão recebe o marcador.
Assim, resposta perdida após a gravação ou restart antes de `pdf_delivered` não repetem uma entrega já marcada no OTCS.
Não remova o marcador durante a reconciliação. A checagem pressupõe um único processo do orquestrador, conforme o deploy.

### 4.4 disposition
Localiza a tarefa de firma por `SIGN_TASK_NAMES`, **só no subprocesso do acordo** (`subworkflowId` gravado; seção 6), no
`processId` do acordo:

| Onde está a tarefa | O que acontece |
|---|---|
| `current` | se o OTCS informa os responsáveis (`assigneeIds`) e o usuário de integração não está entre eles, **não** tenta o SendOn: espera com backoff (stage `disposition`, log info: `la tarea de firma (N "nome") está asignada a otro usuario (ids); reasígnela al usuario de integración`); esgotadas as tentativas, `needs_attention` `retries_exhausted` (reabre sozinho; resolve-se reatribuindo a tarefa). `assigneeIds` desconhecido (null) ou **vazio** (`[]`, ex.: atribuição a grupo, sem ids de usuário) mantém o comportamento anterior: tenta o SendOn, sem consultar o usuário de integração. Depois: lê o formulário (`custom_actions`); disposição ausente → `needs_attention` permanente listando as disponíveis; senão (opcional: grava atributos) e SendOn com a disposição, no `processId/subprocessId/taskId` **resolvidos** |
| `completed` (recuperação manual, ex.: alguém clicou Firmado) | conclui com `completed_externally=true`, `disposition=null`; log info; **não** é `needs_attention`. Exceção: com `start_sendon_done=false` e a tarefa de início `current` no mesmo subprocesso, a firma `completed` é de uma passagem anterior do mapa (laço): envia o início primeiro e relocaliza. Se a firma ainda aparece `completed` logo depois, é retry transitório (não conclusão externa): vale tanto na mesma execução quanto nos retries seguintes enquanto o SendOn de início nosso (`start_sendon_at`, gravado só quando o SendOn é feito por nós, nunca no caminho "já enviada") for igual ou posterior ao resultado final (`final_at`); esgotadas as tentativas, `needs_attention` `retries_exhausted`. Um início enviado antes do final (caso normal) mantém a conclusão externa |
| ainda não existe e a tarefa de início está `current` | executa a etapa start agora e relocaliza (uma vez) |
| `next` / `absent` | retry transitório (vira `needs_attention` pelo limite de tentativas); se existir só em outro subprocesso, a mensagem traz os ids |
| `ambiguous` (vários subprocessos, acordo sem dica clara) | `needs_attention` permanente; nada é enviado |
| processo 404 | `needs_attention` permanente "workflow inexistente" |

Se o formulário não puder ser lido (ex.: permissão) a disposição configurada é enviada mesmo assim.
Uma lista de ações vazia em formulário legível significa disposição indisponível. Se o PUT falhar com 4xx, a integração
consulta de novo o processo: a mesma tarefa já concluída é tratada como conclusão externa, sem reenviar; senão o 4xx
também é retry com backoff (não vai direto para `needs_attention`).

### 4.5 Prazo de 15 dias e caducidad (DUE_DATE)
**Prazo no `/start`.** O workflow tem um atributo oculto `DUE_DATE` (inteiro, em dias; rótulo em `START_FIELD_DUE_DATE`, vazio
desliga). O `/start` o lê pelo rótulo no formulário da tarefa; por ser oculto, se não vier no formulário tenta os atributos do
subprocesso e depois os do processo (`GET /v2/workflows/status/info`). Aceita `15`, `" 15 "` e `15.0`; só vale inteiro de 1 a 365.
Vazio ou ausente: **silencioso** (sem aviso), o acordo é criado sem expiração. Inválido (texto, 0, negativo, fracionário, > 365) ou
erro na leitura: **aviso** no log e o acordo é criado sem expiração (o `DUE_DATE` nunca derruba o `/start`). A leitura (inclusive o
fallback por atributos) só acontece quando o acordo vai mesmo ser criado: a recarga da página, que devolve o acordo existente, não a faz. Com o valor, o acordo é criado no Adobe com `expirationTime` = agora + dias (ISO 8601).
O prazo é do Adobe: o orquestrador não conta tempo, só reage ao `AGREEMENT_EXPIRED`/`EXPIRED`. A leitura acontece na chamada
que cria o acordo (o `409 REASSIGN_REQUIRED` não a faz) e só com `START_VERIFY_WORKFLOW=true` (ou caminho legado, que também
valida): só `START_VERIFY_WORKFLOW=false` não lê nada do OTCS e deixa o acordo sem expiração.

**Caducidad (`EXPIRED_STOP_WORKFLOW=true`, padrão).** No resultado final expirado, a tarefa de firma recebe o SendOn com
`DISPOSITION_EXPIRED` (`Rechazado`) e o comentário de caducidad (`Firma cancelada por caducidad: ...`). Depois disso, o que acontece
depende de onde a firma vive:

- **Fluxo puro** (a firma é o próprio workflow: tarefa de firma com `subprocessId` == `processId`, WORKID == SUBWORKID): stop do
  processo `workflowId` (`PUT /v2/processes/{id}/status`, o mesmo alvo do cancelamento). A API do OTCS não tem comentário avulso em
  workflow (só o `comment` do SendOn) e um processo parado não recebe SendOn; por isso a ordem é SendOn e depois stop.
- **Subfluxo** (a tarefa de firma está num subprocesso: `subprocessId` != `processId`, o caso real de produção): **só a firma é
  cancelada** (SendOn `Rechazado` + comentário). O fluxo pai não é parado e segue pelo próprio ramo `Rechazado`.

O usuário de integração precisa de permissão para parar processos (só no fluxo puro). Stop recusado com o processo já
parado/concluído (inclusive quando o ramo `Rechazado` já encerrou o fluxo) conta como sucesso.
Persistência (migração v5): `workflow_stop_pending` marca o SendOn feito com o stop ainda por fazer (só existe no fluxo puro);
`workflow_stopped_at` registra o stop. Se o stop falhar, é falha da etapa `disposition` (retry com backoff, depois
`retries_exhausted`); a tentativa seguinte **não** repete o SendOn e só refaz o stop (sem a marca, uma tarefa concluída é conclusão
externa e **não** para o fluxo). No fluxo puro o acordo só fica `sendon_done` com o stop feito; no subfluxo o SendOn já basta.
Assinado, recusado e cancelado nunca param o fluxo. Não usa `cancel_requested_at` (isso é "cancelado por pedido").
`EXPIRED_STOP_WORKFLOW=false`: comportamento antigo (só a disposição, comentário `Acuerdo expirado en Adobe Sign`, sem stop).

**Achados do QA (27/10/2026)**, no fluxo puro (mapa Firma, 12348049):

- O ramo `Rechazado` do próprio mapa já conclui o workflow. Por isso o stop responde 400 "No permission to change the status of the
  process to -2"; o stopper relê o estado, vê `completed` e conta como sucesso. Fica uma linha ERROR no log, sem efeito (inofensiva).
- O comentário do SendOn só aparece na tarefa se o mapa tiver comentários ligados. No QA, o mapa Firma e todos os "Flujo documental"
  têm `comments_on=false` (lido em `GET /v2/workflows/status`); Contratación tem ligado. Ligar os comentários nos mapas é tarefa do
  administrador do Content Server.
- A "Description" do workflow (aba General) fica somente leitura depois de iniciado: o handler clássico `func=work.statusdone` aceita
  o POST e ignora o campo (o Title persiste). Por isso ela não é usada.

Com o stop pendente, a retentativa o refaz **antes** de localizar a tarefa de firma: mesmo com a tarefa ausente do `step_list` ou
com a leitura do processo falhando (ex.: 404), o stop é tentado.

**Riscos aceitos:**
- Janela de queda entre o SendOn bem-sucedido e a gravação de `workflow_stop_pending` (fluxo puro): a retentativa vê a tarefa concluída, trata
  como conclusão externa e **não** para o fluxo (que fica parado em "Rechazado"/seguinte; parar à mão).
- Se o Adobe recusar o `expirationTime`, o `/start` falha para os fluxos com `DUE_DATE` (500 genérico; de propósito não há
  retentativa silenciosa sem o prazo, para nunca criar um acordo sem a caducidad que o fluxo pediu).
- Prazo além da janela do polling (`POLL_MAX_AGE_DAYS`, padrão 90): o `/start` grava `expires_at` (o mesmo instante ISO enviado
  ao Adobe como `expirationTime`; `NULL` sem `DUE_DATE`; na adoção, o `expirationTime` lido do Adobe). O polling só deixa de
  consultar um acordo mais velho que `POLL_MAX_AGE_DAYS` depois de `expires_at` + 1 dia; sem `expires_at`, vale só a regra de
  idade. O `/start` registra o prazo no log (`info`: `vence en N días`).
- O Adobe bloqueia a assinatura no prazo, mas pode levar até 12 h para passar o acordo a `EXPIRED`; o comentário (e, no fluxo puro, o stop) no OTCS
  vêm depois disso e ainda dependem do processamento (webhook ou polling) e de eventuais retentativas.

**Não validado em QA:** o campo `expirationTime` na criação do acordo (REST v6; se o Adobe o aceita no formato enviado), a leitura
de um atributo oculto pelo formulário e por `status/info`, e o stop de um processo **ativo** pelo usuário de integração depois do SendOn
(no QA o processo já estava concluído pelo ramo `Rechazado`, ver os achados acima). O subfluxo (só a firma cancelada) é coberto apenas
por testes com OTCS falso.

## 5. Retry, atenção e reabertura

- **Backoff**: `RETRY_BASE_MS` × 2^(n−1), limitado a `RETRY_MAX_MS` (1 min … 1 h).
- **Permanente**: só problema de dado/configuração que retentar não resolve: acordo sem `workflowId`/`nodeId`/`attachId`,
  processo inexistente (404), disposição inexistente nas ações da tarefa, tarefa ambígua entre subprocessos →
  `needs_attention` imediato (`attention_kind=permanent`).
- **Transitório**: qualquer outro erro do OTCS/Adobe, **inclusive 4xx** (400, 403, 409, 423… no PUT, no `addVersion` com
  nó existente, no upload para a pasta, na leitura do processo) → retry com backoff.
- **Exceção inesperada** na reconciliação (bug, não erro do OTCS/Adobe, que as etapas já tratam): conta como falha da etapa
  genérica `reconcile` (com trabalho pendente): backoff, `RETRY_MAX_ATTEMPTS` e, esgotado, `retries_exhausted` (reabre sozinho).
  Sem isso o acordo voltaria à fila a cada tick, só com log. Mensagem do limite: `reintentos agotados en reconcile (n/n): …`.
- **Tentativas esgotadas**: `RETRY_MAX_ATTEMPTS` (padrão 10; 0 = sem limite) → `needs_attention` (`retries_exhausted`), que
  reabre sozinho após `ATTENTION_RETRY_HOURS`.
- Tipos de `attention_kind`: `permanent`, `retries_exhausted`, `config` (disposição vazia), `unconfirmed` (final que o
  Adobe não confirmou, inclusive a troca de resultado bloqueada por PDF já entregue), `event` (`DOCUMENTS_DELETED`;
  `ABORTED` sem o evento de conversão).
- **Reabertura automática**: o poller (com `POLL_ENABLED` true **ou** false) reabre os `needs_attention` do tipo
  `retries_exhausted` cuja última falha (`last_error_at`) é mais antiga que `ATTENTION_RETRY_HOURS` (padrão 6; 0 desliga):
  zera as tentativas, loga warn e reprocessa. Os demais tipos exigem `POST /admin/reconcile/:id`, novo evento final ou
  correção de configuração.

## 6. Resolução dinâmica da tarefa

`GET /v2/workflows/status/processes/{processId}` devolve `results.step_list.{current,completed,next}[]` com
`{ process_id, subprocess_id, task_id, task_name, task_status }`. Em sub-fluxos o `subprocess_id` difere do `process_id`
(o WebReport antigo de contratação enviava `workflowId = subworkflowId = WFID`, o WorkID do pai); endereçar
`/processes/P/subprocesses/P/tasks/3` acertaria a tarefa errada. O nome é normalizado (sem acentos, minúsculas, espaços
colapsados) e casa por **prefixo** (`Aguardar Firma`, `Enviar solicitud de firma (Empleado y/o Firmante 2)`).

O `step_list` do pai traz as tarefas do pai **e de todos os subprocessos** (os já encerrados ficam em `completed`), então a
tarefa só é aceita no **subprocesso do acordo**: nunca se usa a de outro subprocesso (senão o `Firmado` de um acordo
concluiria a tarefa de outro). Os candidatos das três listas são juntados e a prioridade `current` > `completed` > `next`
vale dentro do subprocesso escolhido:
- o `subworkflowId` gravado tem a tarefa → vale ele;
- o `subworkflowId` é um subprocesso real (≠ pai) que não tem a tarefa → `absent` (retry; a mensagem lista em que outros
  subprocessos ela existe);
- `subworkflowId` vazio ou igual ao pai (WebReport antigo de contratação, adoção manual sem `subworkflowId`): se a tarefa
  existe em um único subprocesso, vale ele; em mais de um → `ambiguous` → `needs_attention` permanente, sem SendOn.
  Corrigir com `POST /admin/reconcile/:id` e corpo `{"subworkflowId": "<id>"}` (numérico; `422` se não for, `409` se o
  acordo já concluiu). O `/start` usa o subprocesso mais recente na ambiguidade, pois cria o acordo a partir da própria
  tarefa resolvida.
`SIGN_TASK_ID` está **obsoleto** (não endereça mais a disposição).

## 7. Rastreabilidade e adoção de acordos

`createAgreement` envia `externalId.id = otcs|wf=<workflowId>|sub=<subworkflowId>|node=<nodeId>|attach=<attachId>|sig=<hex>`.
O `sig` são 32 hex (128 bits) do HMAC-SHA256, com `SIGNATURE_SECRET`, sobre `otcs-ext-v1\n<wf>\n<sub>\n<node>\n<attach>`.
O `externalId` é texto livre no Adobe (qualquer usuário da conta pode criar um acordo com ele), por isso a adoção
automática exige o `sig` válido. Acordos criados antes desta mudança (sem `sig`) ou depois de trocar o `SIGNATURE_SECRET`
não são adotados pelo webhook (log warn "sin firma válida"): use `POST /admin/adopt/:id`. Um `externalId` assinado
copiado para outro acordo também não é adotado se o mesmo workflow/subprocesso/documento já tiver qualquer acordo no
store, aberto ou encerrado (consequência aceita: uma queda do `/start` entre criar o acordo e gravá-lo, num ciclo
posterior do mesmo workflow, exige `POST /admin/adopt/:id`). Risco residual: com o banco perdido, a cópia de um `externalId` assinado não se distingue do original (só uma
checagem do remetente/conta no Adobe fecharia isso).

- **Webhook de acordo desconhecido** (banco efêmero perdido, deploy novo) com `ADOPT_UNKNOWN_AGREEMENTS=true`: consulta o
  Adobe, faz o parse do `externalId`; se for nosso **e tiver o `sig` válido** cria o registro (`adopted=true`,
  `start_sendon_done=false`, `fileName` = nome do acordo sem o prefixo `Documento `, `expires_at` = `expirationTime`
  do Adobe, quando presente) e reaplica o evento; senão log warn. O webhook **espera a adoção por até 8 s** e responde
  conforme o resultado:
  - acordo conhecido: 200 na hora (sem espera);
  - recusa (sem `externalId` nosso, sem `sig` válido, fluxo já registrado, 4xx do Adobe): 200, como antes;
    o evento não é gravado. Se o **payload do webhook já traz o `externalId`** (`agreement.externalId`, quando o Adobe o inclui) e ele
    não é nosso (formato inválido ou `sig` que não confere), a recusa é imediata, sem consultar o Adobe: um Adobe fora do ar (ex.:
    `REFRESH_TOKEN_MISSING`) não gera 503 para um acordo que não é nosso;
  - falha transitória ao ler o acordo no Adobe (rede, 5xx, 401/408/429) ou demora acima de 8 s: **503**, para o
    Adobe reenviar. Nada foi persistido; se a adoção terminar em segundo plano, o reenvio é deduplicado por
    `notificationId`;
  - erro ao persistir o evento: 500.
  A fila confirma a etapa start no OTCS: envia apenas se a tarefa de início ainda estiver ativa; se já
  avançou, só marca como concluída. Isso recupera também um restart entre criar o acordo e enviar o início, mesmo com
  `POLL_ENABLED=false`. Acordos de outras integrações da mesma conta são lembrados por 10 min (sem nova consulta por evento).
- **`POST /admin/adopt/:id`** (Basic Auth): adota manualmente e roda `reconcile(refresh, manual)`. Sem `externalId`
  utilizável (acordos criados antes desta versão) aceita JSON `{ "workflowId", "subworkflowId"?, "nodeId", "attachId", "fileName"? }`
  (numéricos). `409` já existe; `422` faltam dados (devolve `missing`); `404` não existe no Adobe.

## 8. Atributos do workflow com dados do Adobe (opcional)

Desligado por padrão (`WF_ATTRIBUTES_ENABLED=false`). Quando ligado, a integração grava, **em best effort**, dados do
Adobe nos atributos do workflow: na criação (tarefa de início, antes do SendOn), a cada mudança do estado Adobe ou do
estado da integração enquanto a tarefa de firma está ativa, e imediatamente antes da disposição final. As chaves
`WorkflowForm_N` são resolvidas pelo **rótulo** no formulário da tarefa (`GET /v1/forms/processes/tasks/update`). Rótulo
inexistente no mapa é ignorado (log info, uma vez por acordo); erro só gera `warn` — nunca falha nem bloqueia a etapa
seguinte. Um fingerprint (`wf_attrs_fingerprint`) evita regravar o mesmo conjunto.

**Atributos a criar nos mapas** (tipo *String*; os rótulos são configuráveis, rótulo vazio desliga o atributo) — em todos
os mapas que contêm a tarefa de início/firma (`Firma`, `Firma_Documental`, `Firma_Contratación_Activo/Inactivo`), e
incluídos nos formulários dessas tarefas:

| Rótulo padrão (env) | Conteúdo | Tipo | Tamanho sugerido |
|---|---|---|---|
| `Adobe ID Acuerdo` (`WF_ATTR_AGREEMENT_ID`) | ID do acordo no Adobe | String | 100 |
| `Adobe Estado` (`WF_ATTR_STATUS`) | estado Adobe (`OUT_FOR_SIGNATURE`, `SIGNED`...) | String | 50 |
| `Adobe Último Evento` (`WF_ATTR_LAST_EVENT`) | último evento recebido (`AGREEMENT_ACTION_COMPLETED`...) | String | 100 |
| `Adobe Fecha Actualización` (`WF_ATTR_UPDATED_AT`) | data/hora ISO UTC da gravação | String | 30 |
| `Estado Integración Firma` (`WF_ATTR_INTEGRATION_STATE`) | estado da integração (`pending`, `pdf_delivered`, `needs_attention`...) | String | 30 |

> **Aviso:** a atualização de atributos de uma tarefa em andamento usa
> `PUT /v2/processes/{p}/subprocesses/{s}/tasks/{t}` com `body={"action":"formUpdate","values":{...}}`, descrito em fóruns da
> OpenText e **ausente da especificação oficial**. Ainda **não foi verificado em QA**. Valide em QA (um acordo de teste, com
> os atributos criados e visíveis no formulário da tarefa) antes de ligar `WF_ATTRIBUTES_ENABLED=true` em qualquer ambiente.

## 9. Variáveis de ambiente deste fluxo

| Variável | Padrão | Efeito |
|---|---|---|
| `SIGN_TASK_NAMES` | `Aguardar Firma` | nomes (lista por vírgula, prefixo) da tarefa de firma |
| `START_TASK_NAMES` | `Enviar solicitud de firma` | nomes da tarefa de início |
| `SIGN_TASK_ID` | `3` | **obsoleto** |
| `DISPOSITION_SIGNED` / `_REJECTED` | `Firmado` / `Rechazado` | ações da tarefa de firma |
| `DISPOSITION_EXPIRED` / `_RECALLED` / `_CONVERSION_FAILED` | `Rechazado` | vazio ⇒ `needs_attention` |
| `EXPIRED_STOP_WORKFLOW` | `true` | acordo expirado: com o comentário de caducidad; no fluxo puro (firma = workflow), depois da disposição para o fluxo no Content (exige permissão de stop); no subfluxo só a firma é cancelada (seção 4.5) |
| `START_FIELD_DUE_DATE` | `DUE_DATE` | rótulo do atributo oculto com o prazo em dias (1 a 365) enviado ao Adobe como `expirationTime`; vazio desliga (seção 4.5) |
| `POLL_MAX_AGE_DAYS` | `90` | idade (desde a criação) além da qual o polling deixa de consultar um acordo sem resultado final; com `expires_at`, só depois de `expires_at` + 1 dia (seção 4.5) |
| `ATTENTION_RETRY_HOURS` | `6` | reabertura automática de `retries_exhausted` (0 desliga) |
| `ADOPT_UNKNOWN_AGREEMENTS` | `true` | adoção de acordo desconhecido pelo `externalId` assinado; o webhook espera até 8 s e responde 503 na falha transitória (seção 7) |
| `WEBHOOK_CLIENT_IDS` | vazio | ClientIds extras aceitos no webhook além do `CLIENT_ID` |
| `WF_ATTRIBUTES_ENABLED` | `false` | grava dados do Adobe nos atributos do workflow |
| `WF_ATTR_AGREEMENT_ID`, `WF_ATTR_STATUS`, `WF_ATTR_LAST_EVENT`, `WF_ATTR_UPDATED_AT`, `WF_ATTR_INTEGRATION_STATE` | ver seção 8 | rótulos dos atributos (vazio desliga) |
| `CANCEL_ENABLED` | `false` | liga o `POST /cancel` do WebReport do workflow de cancelamento (desligado => 404); as rotas `/admin/cancel*` não dependem dele |
| `CANCEL_TASK_NAMES` | `Cancelar Flujo de Firma` | tarefa do workflow de cancelamento que roda o WebReport (prefixo normalizado). **Provisório** |
| `CANCEL_FIELD_TARGET_WORKFLOW` / `CANCEL_FIELD_TARGET_SUBWORKFLOW` | `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` | rótulos dos atributos do fluxo a cancelar (o segundo é opcional). **Provisórios** |
| `CANCEL_NOTIFY_SIGNERS` | `false` | o Adobe avisa os signatários do cancelamento (`notifyOthers`) |

## 10. Cancelamento de fluxos (ticket 2026060410003715)

Detalhes, decisões e pontos em aberto: [`DESIGN_TICKET_2026060410003715.md`](DESIGN_TICKET_2026060410003715.md). Um workflow
de cancelamento no Content chama o orquestrador com o ID do fluxo a cancelar (lido dos atributos do workflow, nunca do corpo);
o orquestrador cancela o acordo no Adobe e faz o SendOn da tarefa do workflow de cancelamento, que então cancela o fluxo original
no Content. O orquestrador **não** encerra o fluxo original.

- **Entradas**: `POST /cancel` (WebReport; `CANCEL_ENABLED=true`; `/auth` Basic + HMAC v2 com nonce), `POST /admin/cancel/:agreementId`
  e `POST /admin/cancel-workflow/:workflowId` (Basic Auth).
- **Acordo escolhido**: o aberto (sem `sendon_done`) do `workflowId`, com `subworkflowId` exato se informado; nunca o de outro
  subprocesso. Vários abertos sem subprocesso => `409 AMBIGUOUS` (nenhum é cancelado); nenhum => `404` com a dica de
  `POST /admin/adopt/:id` (acordos do orquestrador antigo).
- **Antes de cancelar** consulta `GET /agreements/{id}`: em andamento => `PUT /agreements/{id}/state` (`CANCELLED`);
  `CANCELLED`/`ABORTED` => idempotente (sem novo cancelamento); `SIGNED` ou outro final => `409`; falha do Adobe => `503`, nada é marcado.
  Se o `PUT` falha, o acordo é reconsultado uma vez: `CANCELLED`/`ABORTED` => a resposta se perdeu mas o Adobe cancelou, conta como
  confirmado (warn no log); outro estado ou nova falha => `503`.
- **Depois de confirmado**, o acordo é encerrado (`state=cancelled`, `sendon_done=1`, `start_sendon_done=1`, `disposition=null`,
  `cancel_requested_at`/`cancel_source`) com o evento `CANCEL_REQUESTED` no histórico. O `AGREEMENT_RECALLED` seguinte **não gera
  `Rechazado`**: o webhook só vai ao histórico (sem reconciliação), o polling e a fila de retry não enxergam mais o acordo e
  `reconcile` devolve `done`. Durante o `PUT` a reconciliação do acordo fica em espera (`hold`), para o evento que chegar antes da marcação.
  Decisão padrão, revisável.
- **Rotas admin** (`/admin/cancel*`): não fecham o fluxo no Content (a resposta 200 traz `contentFlow: 'unchanged'` + `note`, e há
  um `warn`); não mandam `Rechazado` porque esse ramo dos mapas pode disparar ações de negócio que não são "cancelar".
- **Tarefa do workflow de cancelamento** (`POST /cancel`): precisa estar `current` e atribuída ao usuário de integração
  (`409 REASSIGN_REQUIRED` com `handoff` se não); o SendOn (sem disposição) só acontece depois do cancelamento confirmado. Falha no
  SendOn => `503 SENDON_FAILED`; repetir é idempotente.
- **Modo direto** (`POST /cancel/direct/auth`, `POST /cancel/direct` e `POST /cancel/direct/preview`; WebReport executado sozinho, sem
  workflow; só existem com `CANCEL_ENABLED=true`, `CANCEL_DIRECT_ENABLED=true` **e** uma credencial Basic:
  `CANCEL_DIRECT_AUTH_USER`/`CANCEL_DIRECT_AUTH_PASS` (as duas, opcionais) ou, sem elas, a do `/auth` (`START_AUTH_*` ou `LOG_*`); sem nenhuma as rotas não são montadas e o startup registra o erro, senão `404`): a assinatura vem
  de `/cancel/direct/auth` (com essa credencial Basic), feita com a chave derivada `HMAC(SIGNATURE_SECRET, 'cancel-direct')`; o `/auth` genérico não
  vale nas rotas diretas e a assinatura direta não vale em `/start` nem `/cancel`. **Risco aceito:** com uma credencial única para tudo (`LOG_*`, `/auth` e modo direto), quem puder ler a fonte de qualquer WebReport que a embuta pode usar o mesmo Basic para chamar `/admin` e para cancelar ou parar fluxos pelo modo direto. Os alvos (`targetWorkflowIds`, lista; `targetSubworkflowId`
  opcional, só com um alvo) vêm no corpo e ficam vinculados ao HMAC v2 (a forma canônica ganha as linhas
  `targetWorkflowIds` e `targetSubworkflowId` só quando `targetWorkflowIds` é enviado; sem ele nada muda). Não lê tarefa nem
  formulário, não grava `IDs Cancelados` e não faz SendOn (`sentOn: false`). Cancela no Adobe e **sempre** para o fluxo original
  (como `CANCEL_STOP_ORIGINAL=true`, independente do flag). Mesmos itens, `complete`/`pending` e idempotência do lote da tarefa;
  `422` `MISSING_TARGET`/`INVALID_TARGET`/`TOO_MANY_TARGETS`. `requestedBy` (autodeclarado, fora do HMAC) só entra em
  `cancel_source` (`webreport:direct[:<usuário>]`) e no comentário do Adobe. A autorização é a permissão sobre o WebReport no OTCS
  e a credencial Basic direta; a auditoria fica só no banco e nos logs. `POST /admin/cancel-workflow` (`LOG_*`) é um caminho à parte. Ver [`webreports/cancelacion/README.md`](../webreports/cancelacion/README.md).
