# WebReports do Content Server que chamam o orquestrador

Os WebReports do Content Server chamam o orquestrador (`/auth` e depois `/start` ou `/cancel`). Os arquivos deste
repositório são os artefatos; **ninguém os publica no OTCS por você**: copie o conteúdo para o nó do WebReport do ambiente.

Há **uma pasta por fluxo**, cada uma com a página e um `README.md` próprio (nós QA/PROD, o que mudar por ambiente e o
checklist de QA daquele fluxo). Este arquivo é o índice e o **protocolo compartilhado**.

| Pasta | Arquivo | WebReport | Uso | Nó QA | Nó PROD |
|---|---|---|---|---|---|
| [`firma-flujo-puro/`](firma-flujo-puro/README.md) | `Requisicion de Firma.html` | Requisicion de Firma | envio a firma no fluxo puro (workflow = subworkflow) | 650835 | a localizar (equivalente do fluxo puro) |
| [`firma-contratacion/`](firma-contratacion/README.md) | `Requisicion de Firma_Contratacion.html` | Requisicion de Firma_Contratacion | envio a firma nos sub-fluxos de contratação | 702040 | 796139 |
| [`cancelacion/`](cancelacion/README.md) | `Cancelar Flujo de Firma.html` | Cancelar Flujo de Firma | cancelamento de um fluxo de firma (ticket 2026060410003715) | a criar | a criar |

Cada pasta tem o que muda por ambiente e o que ainda está pendente daquele WebReport. O que vale para mais de uma página fica aqui.

## Protocolo v2 (comum a todos)

1. `POST /auth` (Basic Auth) devolve `{v: 2, timestamp, nonce, signature}`. A assinatura (HMAC-SHA256 com `SIGNATURE_SECRET`)
   vincula os campos enviados ao `/auth`, vale 2 minutos e o `nonce` só pode ser usado uma vez. Campos de cada página:
   - envio a firma: `{workflowId, subworkflowId, nodeId, attachId, docName, userEmail1, userEmail2}`;
   - cancelamento: `{workflowId, subworkflowId}` (o workflow de cancelamento; o fluxo a cancelar o servidor lê do formulário).
2. `POST /start` (envio) ou `POST /cancel` (cancelamento) com os **mesmos campos** + `timestamp`, `nonce`, `signature`
   (e `taskId`, se o WebReport enviar; a página do fluxo puro não envia). Cada pedido usa um `/auth` novo (nonce de uso único).

O orquestrador não confia no navegador: com `START_VERIFY_WORKFLOW=true` (padrão) ele consulta o workflow no OTCS,
exige que a tarefa "Enviar solicitud de firma" esteja ativa e usa `DocID`, `AttachID`, `Nombre del Documento` e os
e-mails (`Email Firmante 1/2`) **do formulário da tarefa**. Se o que o navegador mandou diverge, responde 409.
Reabrir/recarregar a página depois de um envio já feito devolve o mesmo acordo (200, `existing: true`), sem criar outro.
O mesmo fluxo vê o acordo do **ciclo** dele, mesmo que já seja final mas ainda não concluído (ver "Respostas do `/start` que as
páginas de envio tratam"). Exceção: com a tarefa de início `current` de novo e o acordo mais recente já **concluído** (o resultado foi
aplicado e o mapa voltou ao envio), é um ciclo novo: o acordo antigo é ignorado e nasce outro.

O `/cancel` segue o mesmo modelo (HMAC v2 + nonce; a assinatura v1 é recusada) e lê o fluxo a cancelar dos atributos da tarefa
de cancelamento no OTCS. Detalhes e códigos de resposta: [`cancelacion/README.md`](cancelacion/README.md) e
[`../docs/DESIGN_TICKET_2026060410003715.md`](../docs/DESIGN_TICKET_2026060410003715.md).

A mesma página de cancelamento tem um **modo direto** (executada sozinha, sem workflow; só com `CANCEL_DIRECT_ENABLED=true` e uma credencial Basic
(`CANCEL_DIRECT_AUTH_USER`/`CANCEL_DIRECT_AUTH_PASS` ou, sem elas, a do `/auth`): chama `POST /cancel/direct/auth` (Basic, a mesma do `/auth`) com
`{targetWorkflowIds, requestedBy?}` e depois `POST /cancel/direct/preview` ou `POST /cancel/direct` com os mesmos campos. A assinatura é
feita com uma chave derivada (`HMAC(SIGNATURE_SECRET, 'cancel-direct')`): a do `/auth` genérico não vale nas rotas diretas e a direta não vale
em `/start` nem `/cancel`. A lista dos fluxos fica vinculada ao HMAC (com `targetWorkflowIds` o canônico ganha as linhas
`targetWorkflowIds` e `targetSubworkflowId`, sem ele nada muda). Cancela no Adobe e sempre para o original; sem tarefa, reatribuição nem
SendOn. Esse WebReport deve ficar restrito por permissões: a fonte leva a credencial direta.

O `/start` também devolve `handoff` (`workflowId`, `subworkflowId`, `taskId`, `integrationUserId`, `assigned`), com os IDs
de tarefa que a página usa para reatribuir (`integrationUserId` é só informativo: o destino fica fixo no WebReport, ver
abaixo). Se a tarefa estiver em sub-fluxo e precisar ser reatribuída **antes** do envio, responde `409` com
`code: 'REASSIGN_REQUIRED'` e `handoff`. Ver a seção de reatribuição abaixo. O `/cancel` também responde
`409 REASSIGN_REQUIRED` com `handoff` quando a tarefa de cancelamento não está com o usuário de integração.

**Regra: só reatribuir com acordo gerado.** A ordem é acordo → reatribuição → SendOn (o SendOn é do servidor, em background).
Nenhuma das páginas de envio reatribui ao abrir. Nunca deixar a tarefa com o usuário de integração sem acordo, se der para evitar.
(No cancelamento não há acordo a gerar: a tarefa só é reatribuída quando o `/cancel` pede `REASSIGN_REQUIRED`, e depois repete-se
`/auth` + `/cancel` uma vez.)

## Respostas do `/start` que as páginas de envio tratam

As duas páginas de envio (`firma-flujo-puro/Requisicion de Firma.html` e `firma-contratacion/Requisicion de Firma_Contratacion.html`)
tratam o mesmo contrato:

| Resposta | Significado | O que a página faz |
|---|---|---|
| `200 { id, handoff }` | acordo criado | reatribui se `handoff.assigned !== true`, confirma e mostra o sucesso |
| `200 { id, existing: true }` | o fluxo já tinha o acordo, ainda aberto | idem; `message` = "Signature already requested. ID: ..." |
| `200 { id, existing: true, final: { kind, state, message } }` | o acordo do fluxo **já terminou** no Adobe (assinado, recusado, expirado, cancelado, falha de conversão) | reatribui se o `handoff` pedir (o acordo existe e o pipeline do servidor ainda precisa do SendOn da tarefa de início e da disposição), confirma e mostra a `final.message` em **aviso** (âmbar, "!"), com o ID do acordo. **Não** mostra "Documento enviado a firma." |
| `409 { code: 'REASSIGN_REQUIRED', handoff }` | sub-fluxo com a tarefa ainda no usuário | reatribui e repete `/auth` + `/start` uma vez (o servidor já validou PDF e duplicidade antes de pedir; ver `docs/REGLAS_DEL_FLUJO.md`) |
| `422 { code: 'NOT_PDF' }` | o documento (`DocID`) não é um PDF válido; nada foi criado no Adobe | mostra a mensagem do servidor e a dica "Suba una versión PDF...", com **Reintentar** visível. **Não** reatribui |
| `409 { code: 'DUPLICATE_OPEN', id, workflowId }` | já existe uma solicitação **aberta** do mesmo documento e destinatários em **outro** fluxo (janela de 15 min) | mostra a mensagem e "Acuerdo abierto: id (flujo workflowId)", com **Reintentar** visível. **Não** reatribui |
| `409 { code: 'PREVIOUS_CYCLE_OPEN', id }` | a tarefa de envio voltou a ser a atual, mas o fluxo tem a solicitação `id` de um envio **anterior** ainda sem concluir (o SendOn de início dela já foi feito) | mostra a mensagem do servidor (leva o ID), com **Reintentar** visível: cancele o acordo antigo ou espere o resultado e reenvie. **Não** reatribui (no sub-fluxo o servidor responde antes de pedir a reatribuição); se a página já tinha reatribuído (pedido sem dicas), ela tenta devolver a tarefa |
| `422` AttachID ("El flujo no tiene la carpeta de destino (AttachID).") | `AttachID` ausente ou não numérico; no sub-fluxo também vale para o `attachId` das dicas, **antes** da reatribuição | mostra a mensagem, com **Reintentar**. No sub-fluxo a tarefa continua com o usuário |
| outros `4xx/5xx` | dados divergentes (409), fluxo fora do passo de envio (409), DocID/e-mails ausentes (422), OTCS indisponível (503)... | mostra a mensagem do servidor, com **Reintentar** |

Reintentar depois de `NOT_PDF` repete o envio inteiro: o servidor baixa a versão atual do nó, então basta subir uma nova versão
PDF no **mesmo** documento. Se o `DocID` do fluxo mudou, recarregue a página (o valor que a página mandou é o do carregamento).

## Por que `&WORKID` e `&SUBWORKID`

- `[LL_REPTAG_&WORKID /]` e `[LL_REPTAG_&SUBWORKID /]` são os IDs **reais** do workflow e do subprocesso onde a tarefa
  está. O orquestrador precisa deles para ler a tarefa certa e para fazer o SendOn / a disposição depois.
- O WebReport antigo do sub-fluxo (702040 em QA, 796139 em PROD) mandava `workflowId = subworkflowId = WFATTR "WFID"`
  (o WorkID do **pai**) e chamava `GET /start?...` sem HMAC. Isso deixava o acordo apontando para o fluxo errado.
- Atributos do formulário (`DocID`, `AttachID`, `Nombre del Documento`, e-mails): a fonte do 702040 lia com
  `&WORKID WFATTR:"..."`. Os atributos estão no **sub-fluxo**, então o arquivo novo usa `&SUBWORKID WFATTR:"..."`
  (no fluxo puro os dois IDs são iguais, por isso a página do fluxo puro já funcionava assim). Se em algum ambiente os
  atributos estiverem mesmo no fluxo pai, troque só essas leituras; os `workflowId`/`subworkflowId` enviados continuam
  sendo `&WORKID`/`&SUBWORKID`.
- A página de cancelamento segue a mesma convenção: manda `&WORKID`/`&SUBWORKID` do workflow de cancelamento e lê os
  atributos `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` com `&SUBWORKID WFATTR:"..."`.
- Mesmo que o front mande IDs imprecisos, o servidor usa o `subprocessId`/`taskId` que **encontra no OTCS** e grava esses.

## Reatribuição da tarefa (REASSIGN)

A tarefa "Enviar solicitud de firma" (e a de cancelamento) precisa estar com o usuário de integração (AdminKeralty, o
`OTCS_USER` do orquestrador), porque o `/start` (ou `/cancel`) lê o formulário dela e faz o SendOn com esse usuário. Se a tarefa
não estiver com ele, `/start` responde 409 ("La tarea no está asignada al usuario de integración.").

Antes, o WebReport reatribuía a tarefa **ao abrir**: se o envio falhasse ou a pessoa fechasse a página, a tarefa saía da
caixa dela e não havia como tentar de novo, e o acordo ainda nem existia (foi o que escondeu a causa no incidente de QA do
workflow 12333200, ver "Incidente de QA" abaixo). **Os WebReports** (`firma-flujo-puro`, `firma-contratacion` e `cancelacion`)
não reatribuem mais ao abrir: o `REASSIGN` fica num ramo `accion=reasignar`, que só
roda quando a página o pede. A ordem nas páginas de envio é:

1. A página envia sozinha: `/auth` e `/start`, com os mesmos campos de antes e sem `taskId`.
2. Se o `/start` responder `409` com `code: 'REASSIGN_REQUIRED'` (sub-fluxo), a página reatribui e repete `/auth` + `/start`
   uma vez. Se essa segunda chamada responder `REASSIGN_REQUIRED` de novo, a página mostra erro e "Reintentar".
3. Depois de um envio cujo `handoff.assigned` não seja `true`, a página reatribui e **confirma**: repete `/auth` + `/start`.
   Só mostra "Listo" se a confirmação responder ok e com `assigned: true` (ou sem `handoff`). Se o acordo já era final
   (`final` na resposta), a página reatribui do mesmo jeito (o acordo existe) e, no fim, mostra o aviso com `final.message`
   no lugar do sucesso. Se responder
   `assigned: false`, `REASSIGN_REQUIRED` ou outro erro HTTP, mostra o erro ("No fue posible asignar la tarea. Intente de
   nuevo.", ou a mensagem do servidor) com "Reintentar". Falha de **rede** na confirmação não bloqueia: vai para o console
   e a página mostra sucesso, porque o servidor cobre com o backoff.
4. Sem `handoff` (orquestrador antigo, sem o campo), a página só mostra o sucesso.
5. `NOT_PDF`, `DUPLICATE_OPEN`, `PREVIOUS_CYCLE_OPEN`, o `422` do AttachID e `LOGIN_REQUIRED` vêm **antes** de qualquer reatribuição
   (inclusive no sub-fluxo, onde o servidor valida com as dicas do corpo antes de responder `REASSIGN_REQUIRED`): nesses casos a
   tarefa continua com o usuário.
6. Reintentar: se o acordo já existe, reatribui e confirma de novo; se não, repete o envio inteiro. O botão fica oculto
   enquanto a execução anterior não termina, e um clique repetido é ignorado.
7. **Devolução da tarefa (só `firma-flujo-puro`).** No sub-fluxo, se a página reatribuiu a tarefa ao usuário de integração e o
   segundo `/start` falha **sem acordo** (resposta de erro, `REASSIGN_REQUIRED` de novo ou falha de rede), a tarefa ficaria com o
   usuário de integração: some da caixa de quem a tinha e nada no servidor volta a olhá-la. Por isso a página chama o ramo
   `accion=devolver` (abaixo) antes de mostrar o erro. A página **nunca afirma como fato** que a tarefa voltou (a marca
   `DEVUELTO_OK` não prova isso, ver o ramo abaixo). Mostra o erro original mais "Se intentó devolver la tarea a su bandeja. Si no
   aparece, contacte al administrador (flujo X, subflujo Y, tarea Z)." quando a marca veio, ou "Es posible que la tarea haya quedado
   asignada al usuario de integración (flujo X, subflujo Y, tarea Z); contacte al administrador." quando o pedido falhou ou veio sem
   a marca. Durante o pedido o texto de estado é "Devolviendo la tarea...".
   O flag `reasignadoSinAcuerdo` é ligado **antes** de `reasignar()` (se o resultado dela for ambíguo, a tarefa pode ter mudado de
   usuário; devolver a quem já a tem não faz nada). Se o segundo `/start` falhar de forma **ambígua** (erro de rede, ou HTTP
   502/503/504 sem `code` no corpo), a página repete `/auth` + `/start` **uma vez** antes de decidir: se der certo, o acordo
   existia (`existing: true`) e segue o caminho de sucesso, sem devolver; `START_IN_PROGRESS` não devolve; qualquer outro resultado
   devolve como antes.
   Não devolve se já existe acordo (`state.acuerdoId`; no fluxo puro o acordo nasce **antes** da reatribuição) nem quando o erro é
   `START_IN_PROGRESS` (outra requisição está criando o acordo agora). O estado `reasignadoSinAcuerdo` persiste: num Reintentar
   posterior, se o envio falhar de novo com o flag ainda ligado (devolução anterior falhou), tenta devolver outra vez.

Na página de cancelamento o `/cancel` não devolve `handoff` quando dá certo (ele já faz o SendOn da tarefa), então não há o passo
de confirmação do item 3: só vale o item 2 (reatribuir e repetir `/auth` + `/cancel` uma vez).

A reatribuição é um pedido ao próprio WebReport, no mesmo origem e com a sessão do usuário. A URL só leva os IDs da tarefa:

```
GET {URLPREFIXFULL}?func=ll&objAction=RunReport&objId=<REPORT_ID>&workid=…&subworkid=…&taskid=…&accion=reasignar
```

(`REPORT_ID` de cada página: ver a tabela do índice e o README da pasta. Está no bloco de configuração de cada página.)

O ramo `accion=reasignar` do arquivo executa, na forma entre aspas que já funciona em QA:

```
[LL_REPTAG_{'[LL_REPTAG_&WORKID /]','[LL_REPTAG_&SUBWORKID /]','[LL_REPTAG_&TASKID /]'} WFTASKACTION:REASSIGN:11742766 /]
```

e responde só com `REASIGNADO_OK`. A página considera a reatribuição feita apenas se essa marca vier na resposta; a marca
existe só nesse ramo. O ramo é **idêntico** nas três páginas (só muda o comentário).

**O destino não vem da URL.** O usuário de integração fica fixo no ramo, na linha `WFTASKACTION:REASSIGN:11742766`, com um
comentário logo acima. A URL leva só a tarefa (`workid`, `subworkid`, `taskid`), e a página valida que são dígitos antes de
pedir. Por isso o `integrationUserId` do `handoff` é informativo: a página não o usa.

### Ramo `accion=devolver` (só `firma-flujo-puro`)

```
[LL_REPTAG_{'[LL_REPTAG_&WORKID /]','[LL_REPTAG_&SUBWORKID /]','[LL_REPTAG_&TASKID /]'} WFTASKACTION:REASSIGN:[LL_REPTAG_ACTUALUSERID /] /]
```

e responde só com `DEVUELTO_OK`. Devolve a tarefa ao **usuário que executa o WebReport** (o mesmo que a tinha antes de a página
reatribuí-la), sem ID fixo; a URL não escolhe o destino. A marca (`DEVUELTO` + `_OK` montado em JS, como a do `reasignar`) é impressa
**incondicionalmente** depois do `WFTASKACTION`: **não está validado** que o ramo deixe de imprimi-la quando o OTCS recusa a
reatribuição, e ela pode aparecer mesmo com a falha. Por isso a marca só diz "o pedido foi feito", nunca "a tarefa voltou", e a página
sempre mostra os IDs. Best effort: nunca bloqueia a mensagem de erro.

**Não validado no OTCS de QA (validar antes de publicar):**
- que `[LL_REPTAG_ACTUALUSERID /]` (sem `&`: quem abriu a página, mesmo com RunAs; o `USERID` devolveria o usuário do RunAs) resolve para o ID numérico de quem executa o
  WebReport. Se não resolver, o `REASSIGN` recebe o texto da tag e a devolução falha;
- que um usuário comum pode reatribuir uma tarefa que **já não está atribuída a ele** (agora é do usuário de integração). Se o
  OTCS não permitir, a marca pode sair mesmo assim (ver acima); se o ramo precisar de certeza, deve ler o responsável da tarefa
  depois do `WFTASKACTION` e só então imprimir a marca (pós-condição).

**Superfície de segurança dos ramos `reasignar` e `devolver`.** São `GET` com os IDs da tarefa na URL, executados com a sessão de
quem os chama: qualquer usuário que consiga executar o WebReport pode puxar para o usuário de integração (ou para si) qualquer tarefa
sobre a qual tenha permissão no OTCS, bastando montar a URL; e, sendo `GET` com cookie de sessão, o pedido também pode ser disparado
por outro site (CSRF) com um link ou imagem enquanto a pessoa está logada. O destino fixo (`reasignar`) e o usuário da sessão
(`devolver`) limitam o estrago, mas não impedem isso. Recomenda-se **restringir as permissões do WebReport** (só os grupos que
realmente enviam documentos a firma) e não publicá-lo para usuários que não precisam dele.

### Incidente de QA (workflow 12333200)

O usuário subiu um HTML no lugar do PDF. O `/start` criou o acordo A (os bytes seguem ao Adobe como `application/pdf`), a página
reatribuiu a tarefa e chamou o `/start` de confirmação; nesse meio tempo o Adobe cancelou A por problema de conversão, e o
servidor respondeu o 409 de duplicidade (A já era final, não "aberto"), escondendo a causa. Em background o pipeline fez o
SendOn e mandou `Rechazado`. Agora: o servidor recusa o não-PDF antes do Adobe (`NOT_PDF`), o mesmo fluxo sempre vê o acordo dele
(`existing` + `final`, enquanto o resultado ainda não foi aplicado ao fluxo) e a trava de 15 min só vale para acordo aberto de outro fluxo.

### Tarefa "Aguardar Firma" (disposição)

O `REASSIGN` dos WebReports só cobre a tarefa de envio. A disposição (`Firmado`/`Rechazado`) é feita na tarefa
**"Aguardar Firma"** do sub-fluxo de assinatura, que o OTCS cria depois do SendOn da tarefa de envio e atribui conforme o
**mapa**. O orquestrador conclui essa tarefa como `OTCS_USER`. Nenhum WebReport a reatribui, então ela precisa nascer com o
usuário de integração.

**Achado em PROD** (ticket 2026100510004615, leituras GET de 20/10/2026):

- Nos contratos enviados em 01 e 02/10, a "Aguardar Firma" estava atribuída ao AdminKeralty, mas o integrador antigo
  rodava com o usuário nominal (o mesmo do `REASSIGN` do WebReport de PROD). Nenhum desses casos recebeu `Firmado`
  automático, nem quando o PDF assinado chegou ao Content: há caso com o PDF como nova versão do nó e a tarefa ainda em
  "Aguardar Firma".
- Em 05/10 o mapa passou a atribuir a "Aguardar Firma" ao usuário nominal. Num teste de 08/10, com os mesmos IDs enviados
  pelo WebReport (pai nos dois campos), o `Firmado` foi automático. Ou seja, os IDs não explicam a falha; o responsável da
  tarefa explica a parte da disposição.
- As recuperações manuais registradas nos históricos começaram todas por reatribuir a tarefa.

A falta de PDF em parte dos casos é outra falha (entrega ou processamento do webhook) e não se distingue sem os logs de PROD.

**Risco no rollout.** Hoje o mapa de PROD atribui a "Aguardar Firma" ao usuário nominal, e o orquestrador novo roda como
AdminKeralty. O `executeDisposition` (`server/services/reconciliationService.js`) não confere o responsável da tarefa de
assinatura (só o `ensureStartSent` confere o da tarefa de envio): o SendOn falha, o acordo entra em retry com backoff e
termina em `needs_attention` (`retries_exhausted`, reaberto a cada 6 h). Como o PDF é entregue antes da disposição, cada
acordo repetiria o cenário acima: PDF no nó, tarefa parada. Por isso:

- O responsável da "Aguardar Firma" no mapa, o `OTCS_USER` do orquestrador e o ID do `REASSIGN` dos WebReports precisam
  apontar para o **mesmo** usuário, e mudar juntos. Mapa no AdminKeralty com o integrador antigo (usuário nominal) repete
  o defeito de 01–02/10; mapa no usuário nominal com o orquestrador novo faz a disposição falhar.
- Workflows já iniciados seguem a versão do mapa com que começaram. Os que estiverem antes ou em "Aguardar Firma" na hora
  da troca ficam com o responsável antigo e precisam ser reatribuídos à mão (senão vão para `needs_attention`).
- Atribuir a tarefa a um grupo não foi testado.
- No QA, o mapa Firma (650736) já está certo (teste de 21/10/2026, `Firmado` pelo orquestrador). Conferir os mapas de
  Contratación e Documental antes de testá-los.

## O que muda em PROD (comum)

Cada página tem o que depende do ambiente em dois lugares: o bloco **CONFIGURACAO POR AMBIENTE** no topo do script
e a linha `WFTASKACTION:REASSIGN` do ramo `reasignar`. Os itens específicos de cada WebReport estão no README da pasta; os comuns:

1. `SERVER_URL`: a URL da Route do orquestrador em OpenShift (hoje os arquivos têm a de QA no Render,
   `https://signature-orchestrator-api-2gim.onrender.com`).
2. Usuário de integração: trocar `11742766` (QA, AdminKeralty) pelo ID do AdminKeralty de PROD na linha
   `WFTASKACTION:REASSIGN:11742766` do ramo `reasignar` e no comentário de configuração do script. Conferir que é o mesmo
   `OTCS_USER` do orquestrador de PROD: a confirmação só passa se a tarefa ficar com esse usuário.
3. `REPORT_ID` é o ID do próprio WebReport no ambiente, usado no pedido `accion=reasignar`. O WebReports não tem tag
   para o ID do próprio relatório (`[LL_REPTAG_REPORTID /]` não existe e quebra o WebReport).
4. Usuário/senha Basic dos WebReports (`BASIC_USER`/`BASIC_PASS`, no bloco de configuração; no repositório ficam os
   placeholders `ADOBE-LOGS`/`ADOBE-LOGS-PASS`): devem ser iguais a
   `START_AUTH_USER`/`START_AUTH_PASS` do orquestrador (ou, sem elas, `LOG_USER`/`LOG_PASS`). Recomenda-se usar credencial
   própria do WebReport (o texto fica visível a quem abre a página; ela só serve para `/auth`, não abre `/admin` nem `/logs`).
5. `CORS_ORIGINS` do orquestrador: o padrão é a origem de `OTCS_BASE` (`https://otcs.g115.opentext.cloud` em PROD). Se o
   WebReport for servido de outra origem, liste-a.
6. Mapas: a tarefa "Aguardar Firma" de cada sub-fluxo de assinatura atribuída ao mesmo usuário do item 2 (ver
   [Tarefa "Aguardar Firma"](#tarefa-aguardar-firma-disposição)). Não é configuração do WebReport, mas sem ela a disposição
   não acontece.

## Ordem de rollout (sem janela de erro)

1. **Deploy do orquestrador** com as flags de transição ligadas: `START_LEGACY_GET_ENABLED=true` e
   `START_LEGACY_SIGNATURE=true`. Os WebReports antigos (GET sem HMAC / HMAC só do timestamp) continuam funcionando, agora
   sempre validados contra o OTCS; cada uso gera `warn` no log pedindo a atualização.

   **Troca de usuário em PROD.** Isso só vale se o `OTCS_USER` for o mesmo usuário que o WebReport antigo usa no
   `REASSIGN` (em PROD, o usuário nominal). Com o orquestrador novo rodando como AdminKeralty, o `/start` do WebReport
   antigo responde 409 (`REASSIGN_REQUIRED` no sub-fluxo), que a página antiga não trata, e a disposição falha na
   "Aguardar Firma" (ver [Tarefa "Aguardar Firma"](#tarefa-aguardar-firma-disposição)). Há dois caminhos:
   - o orquestrador novo começa com o usuário nominal, e a passagem para AdminKeralty vira um corte à parte; ou
   - o deploy já usa AdminKeralty, e no **mesmo corte** saem os WebReports novos (`REASSIGN` para AdminKeralty) e os
     mapas com a "Aguardar Firma" atribuída a ele.

   Em qualquer dos dois, o corte para AdminKeralty inclui reatribuir à mão a "Aguardar Firma" dos workflows já iniciados
   (eles seguem a versão antiga do mapa). Depois, conferir em `/admin` que nenhum acordo foi para `needs_attention` por
   falha na disposição.
2. **Publicar os WebReports novos** (um por vez, QA antes de PROD). Os dois de envio (fluxo puro e Contratación) dependem do
   orquestrador que devolve `handoff`, `REASSIGN_REQUIRED`, `final`, `NOT_PDF` e `DUPLICATE_OPEN`: publique-os **depois** do deploy desse
   servidor. Com um servidor antigo, a página não reatribui mais ao abrir e o `/start` responde 409 ("La tarea no está asignada
   al usuario de integración."). O WebReport antigo de Contratación (REASSIGN na renderização) segue funcionando com o servidor
   novo, desde que com o mesmo usuário (ver a troca de usuário no item 1), mas continua com o defeito do incidente: só some ao publicar o novo. O WebReport de cancelamento só funciona com
   `CANCEL_ENABLED=true` no servidor (ver [`cancelacion/README.md`](cancelacion/README.md)).
3. **Testar um envio** em cada WebReport (checklists das pastas e o checklist comum abaixo) e conferir nos logs que não há mais
   `warn` de uso legado.
4. **Desligar as flags** (`START_LEGACY_GET_ENABLED=false`, `START_LEGACY_SIGNATURE=false`, ou removê-las): `GET /auth` e
   `GET /start` passam a responder 404 e a assinatura v1 é rejeitada (403).

Rollback: religar as flags e republicar o WebReport antigo.

## Checklist comum de QA (servidor e protocolo)

Itens que valem para as páginas de envio (fluxo puro e Contratación). Os itens específicos de cada WebReport estão no README da pasta.

- [ ] Tarefa reatribuída ao usuário de integração (AdminKeralty, o ID da linha `WFTASKACTION:REASSIGN`) depois do envio
      (e não ao Stiven).
- [ ] Fluxo fora do passo de envio (tarefa já concluída): mensagem "El flujo no está en el paso de envío a firma." (409).
- [ ] Formulário sem e-mails ou sem DocID: erro 422 legível na página.
- [ ] No navegador (DevTools): `OPTIONS /auth` e `/start` respondem com `Access-Control-Allow-Origin` igual à origem do
      OTCS; de qualquer outra origem, sem esse cabeçalho.
- [ ] Logs do orquestrador sem `warn` de "Assinatura v1" / "GET /start (contrato antigo" após o rollout.
- [ ] **NOT_PDF** (as duas páginas): no workflow de QA, trocar o conteúdo do `DocID` por um HTML (ou DOCX) e abrir a página:
      mensagem "El documento a firmar no es un PDF válido." e "Suba una versión PDF...", **Reintentar** visível, nenhum acordo novo
      no Adobe e a tarefa de início ainda com o usuário (no sub-fluxo, também sem `REASSIGN_REQUIRED`). Subir uma versão PDF no mesmo
      nó e clicar em Reintentar: o envio segue.
- [ ] **Acordo final do mesmo fluxo** (as duas páginas): com um acordo cancelado/rejeitado do mesmo workflow + documento
      (ex.: recarregar a página depois de o Adobe cancelar por conversão): a página mostra o aviso âmbar com a mensagem do
      resultado e o ID do acordo, **não** "Documento enviado a firma." nem o 409 antigo de duplicidade, e o fluxo segue sozinho
      (SendOn da tarefa de início e disposição `Rechazado`/`Firmado`, nos logs do servidor).
- [ ] **DUPLICATE_OPEN**: dois workflows diferentes com o mesmo documento e os mesmos destinatários, o segundo dentro de 15 min do
      primeiro (ainda aberto): o segundo mostra "...ya tiene una solicitud de firma abierta... en otro flujo." com o ID do acordo e o
      workflow do primeiro. Se o primeiro já terminou (final ou concluído), o segundo **não** é bloqueado.
