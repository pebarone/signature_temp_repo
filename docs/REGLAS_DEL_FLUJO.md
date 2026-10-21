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
| `AGREEMENT_EXPIRED`; polling `EXPIRED` | expirado | não | `DISPOSITION_EXPIRED` = `Rechazado` | `expired` | idem |
| `AGREEMENT_RECALLED`; polling `CANCELLED` sem recusa | cancelado | não | `DISPOSITION_RECALLED` = `Rechazado` | `cancelled` | idem |
| `AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM` | falha de conversão | não | `DISPOSITION_CONVERSION_FAILED` = `Rechazado` | `cancelled` | idem |
| `AGREEMENT_DOCUMENTS_DELETED`; polling `ABORTED` | exige intervenção | não | nenhuma | `needs_attention` (`event`) | integração `needs_attention` |
| `AGREEMENT_ACTION_COMPLETED` com status em andamento; informativos (`CREATED`, `ACTION_REQUESTED`, `MODIFIED`, `EMAIL_VIEWED`, `REMINDER_SENT`...) | progresso/histórico | não | nenhuma | `pending` | estado Adobe atualizado se o polling o viu mudar |
| indisponíveis (`VAULTED`, `KBA_AUTHENTICATED`, `WEB_IDENTITY_AUTHENTICATED`) e desconhecidos | ignorados (desconhecido gera warn) | não | nenhuma | sem mudança | — |

\* Só com `WF_ATTRIBUTES_ENABLED=true` (seção 8). Disposição **vazia** na config ⇒ `needs_attention` (`config`) em vez de
executar. Os mapas verificados só têm as ações `Firmado` e `Rechazado` na tarefa de firma, por isso os três últimos
resultados encerram o fluxo como `Rechazado` (o comentário da tarefa diz o motivo real, ver seção 4.4).
Todo resultado final desta tabela é confirmado no Adobe antes do PDF e da disposição (seção 4.2): se o Adobe disser
outro resultado final, vale o dele.

Comentário gravado na tarefa: `Firmado en Adobe Sign (acuerdo <id>)`, `Rechazado por el firmante en Adobe Sign`,
`Acuerdo expirado en Adobe Sign`, `Acuerdo cancelado en Adobe Sign`, `Adobe Sign no pudo procesar el documento`.

## 3. Máquina de estados

Estados persistidos (`state`): `pending`, `signed`, `pdf_delivered`, `completed`, `rejected`, `expired`, `cancelled`,
`needs_attention`.

```
pending --(final OK)--> signed --(PDF entregue)--> pdf_delivered --(disposição)--> completed
pending --(recusado | expirado | cancelado)--> rejected | expired | cancelled   [sendon_done=1 quando a disposição vai]
qualquer estado aberto --(erro permanente | tentativas esgotadas | config | não confirmado | evento)--> needs_attention
needs_attention --(POST /admin/reconcile/:id | reabertura automática | novo evento final)--> estado aberto
```

Campos que acompanham: `start_sendon_done` (pedido de firma enviado), `pdf_delivered`/`pdf_node_id` (PDF gravado e nó que o
recebeu), `sendon_done`/`disposition` (tarefa concluída pela integração), `completed_externally` (tarefa já concluída
fora da integração), `sign_subprocess_id`/`sign_task_id` (tarefa de firma resolvida), `attention_kind`, `adopted`.

## 4. Etapas

### 4.1 start — envio do pedido de firma
- O `/start` só cria o acordo (com `externalId`), grava o registro com `start_sendon_done=false` e dispara a etapa em
  background; responde sem esperá-la.
- A etapa consulta `GET /v2/workflows/status/processes/{workflowId}` e localiza a tarefa por `START_TASK_NAMES`:
  - `current` → (opcional: grava os atributos) → SendOn com `processId/subprocessId/taskId` resolvidos → `start_sendon_done=true`.
  - já `completed`, ou a tarefa de firma já está `current/completed` → só marca como feito (nada é enviado).
  - não encontrada / SendOn com erro → retry com backoff (o WebReport pode ainda estar ocupando a tarefa).
  - processo inexistente (404) → `needs_attention` permanente.
- Registros com `start_sendon_done=0` e `workflow_id` entram em `listPending`, então o `runQueue`/poller os retoma após restart.
- **Rede de segurança (descoberta; `START_DISCOVERY_TASK_NAMES`, desligada por padrão):** se a página não chama o `/start`
  (fechou, falha de rede), o servidor lê a caixa do `OTCS_USER` (`GET /v2/members/assignments`, tarefas `type 153`) e procura
  as tarefas cujo nome é **exatamente** um dos `START_DISCOVERY_TASK_NAMES` (sem prefixo; acentos e caixa não importam). A
  tarefa precisa ficar visível por `START_DISCOVERY_GRACE_MS` antes da ação, que é o mesmo `/start` (com validação no OTCS).
  Se ela sai da caixa e volta, a carência recomeça. Erro ⇒ nova tentativa só após `START_DISCOVERY_RETRY_MS`. Sucesso ou
  acordo já aberto ⇒ não repete enquanto a tarefa estiver na caixa. Fica fora do poller, então vale com `POLL_ENABLED=false`.

### 4.2 verify
Todo resultado final (webhook ou polling) é confirmado no Adobe por `GET /agreements/{id}` antes do PDF e da disposição:
o `agreement.status` do payload não basta. Um `adobeStatus` já gravado por consulta ao Adobe que confirma o resultado
dispensa nova consulta (é o caso do polling). Em `CANCELLED` consulta-se também `GET /agreements/{id}/events` para separar
recusa de recall; a falha de conversão aceita `CANCELLED` (com ou sem recusa) e `ABORTED`. Confirmado ⇒ segue e grava
`adobeStatus`. Estado em andamento é **transitório** (retry com backoff).
Outro resultado final no Adobe (ex.: webhook `REJECTED` com Adobe `SIGNED`, ou `RECALLED` com evento de recusa) ⇒ **vale o
do Adobe**: grava-se o evento `VERIFY_STATUS_<status>` (`source=verify`), registra-se um warn e o pipeline roda de novo, uma
única vez. Sem resultado final no Adobe (`NEEDS_ATTENTION`, `UNKNOWN`, vazio) ⇒ `needs_attention` (`unconfirmed`); o final
OK não adota outro resultado. Se o PDF já foi entregue e a troca não pode ser aplicada ⇒ `needs_attention` (`unconfirmed`).
Um webhook que troca o resultado já gravado (ex.: `RECALLED` do polling e `REJECTED` do webhook) zera o `adobeStatus`
gravado, para que o verify consulte o Adobe (com os eventos) de novo. Com o mesmo resultado, o `adobeStatus` é mantido e
não há consulta extra.

### 4.3 pdf
Baixa `combinedDocument?attachAuditReport=true` e grava como **nova versão do `nodeId`** (o `DocID` do fluxo: é o nó que o
fluxo devolve ao pai e que a distribuição ao workspace copia). Se o nó não existe mais (404) cai para
`uploadToFolder(attachId)`; sem `attachId` → `needs_attention`. 4xx do OTCS (exceto 401/408/429) é permanente; demais, retry.

A descrição da versão recebe `Adobe Sign: <agreementId>`; a entrega consulta as versões antes de escrever. No fallback,
um novo nó recebe esse marcador na sua descrição; se já existe um nó com o mesmo nome, a versão recebe o marcador.
Assim, resposta perdida após a gravação ou restart antes de `pdf_delivered` não repetem uma entrega já marcada no OTCS.
Não remova o marcador durante a reconciliação. A checagem pressupõe um único processo do orquestrador, conforme o deploy.

### 4.4 disposition
Localiza a tarefa de firma por `SIGN_TASK_NAMES` (dica: o `subworkflowId` gravado), no `processId` do acordo:

| Onde está a tarefa | O que acontece |
|---|---|
| `current` | lê o formulário (`custom_actions`); disposição ausente → `needs_attention` permanente listando as disponíveis; senão (opcional: grava atributos) e SendOn com a disposição, no `processId/subprocessId/taskId` **resolvidos** |
| `completed` (recuperação manual, ex.: alguém clicou Firmado) | conclui com `completed_externally=true`, `disposition=null`; log info; **não** é `needs_attention` |
| ainda não existe e a tarefa de início está `current` | executa a etapa start agora e relocaliza (uma vez) |
| `next` / `absent` | retry transitório (vira `needs_attention` pelo limite de tentativas) |
| processo 404 | `needs_attention` permanente "workflow inexistente" |

Se o formulário não puder ser lido (ex.: permissão) a disposição configurada é enviada mesmo assim.
Uma lista de ações vazia em formulário legível significa disposição indisponível. Se o PUT falhar com 4xx permanente,
a integração consulta de novo o processo: a mesma tarefa já concluída é tratada como conclusão externa, sem reenviar.

## 5. Retry, atenção e reabertura

- **Backoff**: `RETRY_BASE_MS` × 2^(n−1), limitado a `RETRY_MAX_MS` (1 min … 1 h).
- **Permanente**: 4xx do OTCS (exceto 401/408/429), processo inexistente, disposição inexistente na tarefa → `needs_attention`
  imediato (`attention_kind=permanent`).
- **Tentativas esgotadas**: `RETRY_MAX_ATTEMPTS` (padrão 10; 0 = sem limite) → `needs_attention` (`retries_exhausted`).
- Tipos de `attention_kind`: `permanent`, `retries_exhausted`, `config` (disposição vazia), `unconfirmed` (final que o
  Adobe não confirmou, inclusive a troca de resultado bloqueada por PDF já entregue), `event` (`DOCUMENTS_DELETED`/`ABORTED`).
- **Reabertura automática**: o poller (com `POLL_ENABLED` true **ou** false) reabre os `needs_attention` do tipo
  `retries_exhausted` cuja última falha (`last_error_at`) é mais antiga que `ATTENTION_RETRY_HOURS` (padrão 6; 0 desliga):
  zera as tentativas, loga warn e reprocessa. Os demais tipos exigem `POST /admin/reconcile/:id`, novo evento final ou
  correção de configuração.

## 6. Resolução dinâmica da tarefa

`GET /v2/workflows/status/processes/{processId}` devolve `results.step_list.{current,completed,next}[]` com
`{ process_id, subprocess_id, task_id, task_name, task_status }`. Em sub-fluxos o `subprocess_id` difere do `process_id`
(o WebReport antigo de contratação enviava `workflowId = subworkflowId = WFID`, o WorkID do pai); endereçar
`/processes/P/subprocesses/P/tasks/3` acertaria a tarefa errada. O nome é normalizado (sem acentos, minúsculas, espaços
colapsados) e casa por **prefixo** (`Aguardar Firma`, `Enviar solicitud de firma (Empleado y/o Firmante 2)`). Prioridade
`current` > `completed` > `next`; entre vários candidatos, o do subprocesso gravado, senão o de maior `subprocess_id`.
`SIGN_TASK_ID` está **obsoleto** (não endereça mais a disposição).

## 7. Rastreabilidade e adoção de acordos

`createAgreement` envia `externalId.id = otcs|wf=<workflowId>|sub=<subworkflowId>|node=<nodeId>|attach=<attachId>`.

- **Webhook de acordo desconhecido** (banco efêmero perdido, deploy novo) com `ADOPT_UNKNOWN_AGREEMENTS=true`: consulta o
  Adobe em background, faz o parse do `externalId`; se for nosso cria o registro (`adopted=true`, `start_sendon_done=false`,
  `fileName` = nome do acordo sem o prefixo `Documento `) e reaplica o evento; senão log warn. O webhook responde 200
  sem esperar. A fila confirma a etapa start no OTCS: envia apenas se a tarefa de início ainda estiver ativa; se já
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
| `ATTENTION_RETRY_HOURS` | `6` | reabertura automática de `retries_exhausted` (0 desliga) |
| `ADOPT_UNKNOWN_AGREEMENTS` | `true` | adoção de acordo desconhecido pelo `externalId` |
| `WEBHOOK_CLIENT_IDS` | vazio | ClientIds extras aceitos no webhook além do `CLIENT_ID` |
| `WF_ATTRIBUTES_ENABLED` | `false` | grava dados do Adobe nos atributos do workflow |
| `WF_ATTR_AGREEMENT_ID`, `WF_ATTR_STATUS`, `WF_ATTR_LAST_EVENT`, `WF_ATTR_UPDATED_AT`, `WF_ATTR_INTEGRATION_STATE` | ver seção 8 | rótulos dos atributos (vazio desliga) |
| `START_DISCOVERY_TASK_NAMES` | vazio (desligada) | nomes exatos (lista) das tarefas de envio procuradas na caixa do `OTCS_USER` |
| `START_DISCOVERY_GRACE_MS` | `120000` | tempo que a tarefa precisa ficar na caixa antes da ação |
| `START_DISCOVERY_INTERVAL_MS` | `60000` | intervalo de leitura da caixa (mínimo 5000) |
| `START_DISCOVERY_RETRY_MS` | `1800000` | espera após erro antes de nova tentativa |
