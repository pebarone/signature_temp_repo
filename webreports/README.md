# WebReports de envio a firma

Dois WebReports do Content Server chamam o orquestrador (`/auth` e `/start`). Os arquivos deste repositório são os
artefatos; **ninguém os publica no OTCS por você**: copie o conteúdo para o nó do WebReport do ambiente.

| Arquivo | WebReport | Uso | Nó QA | Nó PROD |
|---|---|---|---|---|
| `../template.html` | Requisicion de Firma | fluxo puro (workflow = subworkflow) | 650835 | a localizar (equivalente do fluxo puro) |
| `Requisicion de Firma_Contratacion.html` | Requisicion de Firma_Contratacion | sub-fluxos de contratação | 702040 | 796139 |

Os dois falam o **protocolo v2**:

1. `POST /auth` (Basic Auth) com JSON `{workflowId, subworkflowId, nodeId, attachId, docName, userEmail1, userEmail2}`
   devolve `{v: 2, timestamp, nonce, signature}`. A assinatura (HMAC-SHA256 com `SIGNATURE_SECRET`) vincula esses campos,
   vale 2 minutos e o `nonce` só pode ser usado uma vez.
2. `POST /start` com os mesmos campos + `timestamp`, `nonce`, `signature` (e `taskId`, se o WebReport enviar; o `template.html` novo não envia).

O orquestrador não confia no navegador: com `START_VERIFY_WORKFLOW=true` (padrão) ele consulta o workflow no OTCS,
exige que a tarefa "Enviar solicitud de firma" esteja ativa e usa `DocID`, `AttachID`, `Nombre del Documento` e os
e-mails (`Email Firmante 1/2`) **do formulário da tarefa**. Se o que o navegador mandou diverge, responde 409.
Reabrir/recarregar a página depois de um envio já feito devolve o mesmo acordo (200, `existing: true`), sem criar outro.
O mesmo fluxo vê o acordo do **ciclo** dele, mesmo que já seja final mas ainda não concluído (ver "Respostas do `/start` que as
páginas tratam"). Exceção: com a tarefa de início `current` de novo e o acordo mais recente já **concluído** (o resultado foi
aplicado e o mapa voltou ao envio), é um ciclo novo: o acordo antigo é ignorado e nasce outro.

O `/start` também devolve `handoff` (`workflowId`, `subworkflowId`, `taskId`, `integrationUserId`, `assigned`), com os IDs
de tarefa que a página usa para reatribuir (`integrationUserId` é só informativo: o destino fica fixo no WebReport, ver
abaixo). Se a tarefa estiver em sub-fluxo e precisar ser reatribuída **antes** do envio, responde `409` com
`code: 'REASSIGN_REQUIRED'` e `handoff`. Ver a seção de reatribuição abaixo.

**Regra: só reatribuir com acordo gerado.** A ordem é acordo → reatribuição → SendOn (o SendOn é do servidor, em background).
Nenhuma das duas páginas reatribui ao abrir. Nunca deixar a tarefa com o usuário de integração sem acordo, se der para evitar.

## Respostas do `/start` que as páginas tratam

As duas páginas (`template.html` e `Requisicion de Firma_Contratacion.html`) tratam o mesmo contrato:

| Resposta | Significado | O que a página faz |
|---|---|---|
| `200 { id, handoff }` | acordo criado | reatribui se `handoff.assigned !== true`, confirma e mostra o sucesso |
| `200 { id, existing: true }` | o fluxo já tinha o acordo, ainda aberto | idem; `message` = "Signature already requested. ID: ..." |
| `200 { id, existing: true, final: { kind, state, message } }` | o acordo do fluxo **já terminou** no Adobe (assinado, recusado, expirado, cancelado, falha de conversão) | reatribui se o `handoff` pedir (o acordo existe e o pipeline do servidor ainda precisa do SendOn da tarefa de início e da disposição), confirma e mostra a `final.message` em **aviso** (âmbar, "!"), com o ID do acordo. **Não** mostra "Documento enviado a firma." |
| `409 { code: 'REASSIGN_REQUIRED', handoff }` | sub-fluxo com a tarefa ainda no usuário | reatribui e repete `/auth` + `/start` uma vez (o servidor já validou PDF e duplicidade antes de pedir; ver `docs/REGLAS_DEL_FLUJO.md`) |
| `422 { code: 'NOT_PDF' }` | o documento (`DocID`) não é um PDF válido; nada foi criado no Adobe | mostra a mensagem do servidor e a dica "Suba una versión PDF...", com **Reintentar** visível. **Não** reatribui |
| `409 { code: 'DUPLICATE_OPEN', id, workflowId }` | já existe uma solicitação **aberta** do mesmo documento e destinatários em **outro** fluxo (janela de 15 min) | mostra a mensagem e "Acuerdo abierto: id (flujo workflowId)", com **Reintentar** visível. **Não** reatribui |
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
  (no fluxo puro os dois IDs são iguais, por isso `template.html` já funcionava assim). Se em algum ambiente os
  atributos estiverem mesmo no fluxo pai, troque só essas leituras; os `workflowId`/`subworkflowId` enviados continuam
  sendo `&WORKID`/`&SUBWORKID`.
- Mesmo que o front mande IDs imprecisos, o servidor usa o `subprocessId`/`taskId` que **encontra no OTCS** e grava esses.

## Reatribuição da tarefa (REASSIGN)

A tarefa "Enviar solicitud de firma" precisa estar com o usuário de integração (AdminKeralty, o `OTCS_USER` do
orquestrador), porque o `/start` lê o formulário dela e faz o SendOn com esse usuário. Se a tarefa não estiver com ele,
`/start` responde 409 ("La tarea no está asignada al usuario de integración.").

Antes, o WebReport reatribuía a tarefa **ao abrir**: se o envio falhasse ou a pessoa fechasse a página, a tarefa saía da
caixa dela e não havia como tentar de novo, e o acordo ainda nem existia (foi o que escondeu a causa no incidente de QA do
workflow 12333200, ver "Incidente de QA" abaixo). **Os dois WebReports** (`template.html` e
`Requisicion de Firma_Contratacion.html`) não reatribuem mais ao abrir: o `REASSIGN` fica num ramo `accion=reasignar`, que só
roda quando a página o pede. A ordem é:

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
5. `NOT_PDF` e `DUPLICATE_OPEN` vêm **antes** de qualquer reatribuição (inclusive no sub-fluxo, onde o servidor valida com as
   dicas do corpo antes de responder `REASSIGN_REQUIRED`): nesses casos a tarefa continua com o usuário.
6. Reintentar: se o acordo já existe, reatribui e confirma de novo; se não, repete o envio inteiro. O botão fica oculto
   enquanto a execução anterior não termina, e um clique repetido é ignorado.

A reatribuição é um pedido ao próprio WebReport, no mesmo origem e com a sessão do usuário. A URL só leva os IDs da tarefa:

```
GET {URLPREFIXFULL}?func=ll&objAction=RunReport&objId=<REPORT_ID>&workid=…&subworkid=…&taskid=…&accion=reasignar
```

(`REPORT_ID`: 650835 no `template.html` em QA; 702040 em QA e 796139 em PROD no WebReport de Contratación. Está no bloco de
configuração de cada página.)

O ramo `accion=reasignar` do arquivo executa, na forma entre aspas que já funciona em QA:

```
[LL_REPTAG_{'[LL_REPTAG_&WORKID /]','[LL_REPTAG_&SUBWORKID /]','[LL_REPTAG_&TASKID /]'} WFTASKACTION:REASSIGN:11742766 /]
```

e responde só com `REASIGNADO_OK`. A página considera a reatribuição feita apenas se essa marca vier na resposta; a marca
existe só nesse ramo.

**O destino não vem da URL.** O usuário de integração fica fixo no ramo, na linha `WFTASKACTION:REASSIGN:11742766`, com um
comentário logo acima. A URL leva só a tarefa (`workid`, `subworkid`, `taskid`), e a página valida que são dígitos antes de
pedir. Por isso o `integrationUserId` do `handoff` é informativo: a página não o usa.

### O que mudou em `Requisicion de Firma_Contratacion.html` (702040 em QA, 796139 em PROD)

- **Saiu** o `WFTASKACTION:REASSIGN` da linha 3, que rodava **na renderização**, antes de qualquer acordo. Agora o arquivo é
  `[LL_WEBREPORT_IF "&ACCION" == "reasignar"] ... [LL_WEBREPORT_ELSE] <página> [LL_WEBREPORT_ENDIF]`, como o `template.html`. O ramo
  `reasignar` usa a forma entre aspas com `&TASKID` (não mais a tarefa `2` fixa) e responde `REASIGNADO_OK`.
- O script segue o mesmo fluxo da outra página: `enviar` → `reasignar` → `confirmarAsignacion`, com `REASSIGN_REQUIRED`/`handoff`,
  `final` (aviso âmbar com o ID do acordo), `NOT_PDF` e `DUPLICATE_OPEN` (botão **Reintentar**, que a página não tinha; o clique
  repetido é ignorado). Reintentar com o acordo já criado só reatribui e confirma, não cria outro.
- **Preservado:** o visual (Lottie, fontes, spinner, barra), as tags `WFATTR` (`DocID`, `AttachID`, `Nombre del Documento`,
  `Email Firmante 1/2` lidos com `&SUBWORKID`), `WORKFLOW_ID`/`SUBWORKFLOW_ID` = `&WORKID`/`&SUBWORKID`, o `taskId` informativo `2`
  no `/start`, os textos da página (inclusive os já existentes em português) e a mensagem do servidor no sucesso.
- **Configuração:** `SERVER_URL`, `BASIC_USER`/`BASIC_PASS` (que estavam dentro de `startProcess`) e o novo `REPORT_ID` (`702040`)
  ficaram num bloco de configuração no topo do script. O ID do usuário de integração continua fixo na linha
  `WFTASKACTION:REASSIGN:11742766` do ramo `reasignar` (QA = AdminKeralty; em PROD, a confirmar).
- **Não mudou** (fora deste escopo): o link "Abrir documento" desta página aponta para o host de teste fixo
  (`otcs.g115-test.opentext.cloud`); em PROD precisa ser trocado. Esta página não usa `[LL_WEBREPORT_EXCLUDEHTML /]`: a resposta
  do ramo `reasignar` pode vir com HTML do OTCS ao redor, e tudo bem, porque a página só procura a marca `REASIGNADO_OK`.

### Incidente de QA (workflow 12333200)

O usuário subiu um HTML no lugar do PDF. O `/start` criou o acordo A (os bytes seguem ao Adobe como `application/pdf`), a página
reatribuiu a tarefa e chamou o `/start` de confirmação; nesse meio tempo o Adobe cancelou A por problema de conversão, e o
servidor respondeu o 409 de duplicidade (A já era final, não "aberto"), escondendo a causa. Em background o pipeline fez o
SendOn e mandou `Rechazado`. Agora: o servidor recusa o não-PDF antes do Adobe (`NOT_PDF`), o mesmo fluxo sempre vê o acordo dele
(`existing` + `final`, enquanto o resultado ainda não foi aplicado ao fluxo) e a trava de 15 min só vale para acordo aberto de outro fluxo.

## Visual e dados de `template.html`

- Sem Lottie, sem CDN e sem Google Fonts: a página não carrega nada externo (fonte do sistema). O check de sucesso e o ícone
  de erro são CSS puro.
- Um cartão com o nome do documento, o link "Ver documento", os firmantes (o Firmante 2 só aparece quando tem e-mail), três
  passos (Enviando a Adobe Sign, Asignando la tarea, Listo), a linha de estado (`role="status"`) e os botões "Reintentar"
  (em erro) e "Volver a SuccessFactors" (em sucesso).
- Respeita `prefers-reduced-motion` e funciona a partir de 360 px. Peso: de 39 KB para cerca de 21 KB.
- DocID, AttachID, nome do documento e e-mails vêm de `<textarea>` ocultos, não de strings JS nem de HTML: um nome com
  `<img ...>` aparece como texto e não cria elemento, e um apóstrofo ou aspas não quebram o script.
- **Limite conhecido:** o conteúdo de `textarea` só termina em `</textarea`. Um valor que contenha essa sequência ainda
  quebra o HTML. Não há escape do OTCS verificado para isso (não use sub-tag de escape sem testar). Mitigação pendente:
  validar o nome do documento no formulário, ou testar um escape do OTCS.

## O que muda em PROD

Em cada página, o que depende do ambiente está em dois lugares: o bloco **CONFIGURACAO POR AMBIENTE** no topo do script
e a linha `WFTASKACTION:REASSIGN` do ramo `reasignar`.

1. `SERVER_URL`: a URL da Route do orquestrador em OpenShift (hoje o arquivo tem a de QA no Render,
   `https://signature-orchestrator-api-2gim.onrender.com`).
2. Usuário de integração: trocar `11742766` (QA, AdminKeralty) pelo ID do AdminKeralty de PROD na linha
   `WFTASKACTION:REASSIGN:11742766` do ramo `reasignar` e no comentário de configuração do script. Conferir que é o mesmo
   `OTCS_USER` do orquestrador de PROD: a confirmação só passa se a tarefa ficar com esse usuário. No WebReport de
   Contratación, o ID também está fixo na linha `WFTASKACTION:REASSIGN` do ramo `reasignar`; e `REPORT_ID` vira `796139` em PROD.
3. Link do documento: nada a trocar, o `template.html` usa `[LL_REPTAG_URLPREFIXFULL /]` (base do OTCS do próprio ambiente).
   `RETURN_URL` aponta para o SuccessFactors de preview; confirmar o de PROD.
   `REPORT_ID` é o ID do próprio WebReport no ambiente (`template.html`: QA `650835`; Contratación: QA `702040`, PROD `796139`),
   usado no pedido `accion=reasignar`. O WebReports não tem tag para o ID do próprio relatório (`[LL_REPTAG_REPORTID /]` não existe e quebra o WebReport).
4. Usuário/senha Basic dos WebReports (`BASIC_USER`/`BASIC_PASS`, no bloco de configuração; no repositório ficam os
   placeholders `ADOBE-LOGS`/`ADOBE-LOGS-PASS`): devem ser iguais a
   `START_AUTH_USER`/`START_AUTH_PASS` do orquestrador (ou, sem elas, `LOG_USER`/`LOG_PASS`). Recomenda-se usar credencial
   própria do WebReport (o texto fica visível a quem abre a página; ela só serve para `/auth`, não abre `/admin` nem `/logs`).
5. `CORS_ORIGINS` do orquestrador: o padrão é a origem de `OTCS_BASE` (`https://otcs.g115.opentext.cloud` em PROD). Se o
   WebReport for servido de outra origem, liste-a.

## Ordem de rollout (sem janela de erro)

1. **Deploy do orquestrador** com as flags de transição ligadas: `START_LEGACY_GET_ENABLED=true` e
   `START_LEGACY_SIGNATURE=true`. Os WebReports antigos (GET sem HMAC / HMAC só do timestamp) continuam funcionando, agora
   sempre validados contra o OTCS; cada uso gera `warn` no log pedindo a atualização.
2. **Publicar os WebReports novos** (um por vez, QA antes de PROD). Os dois (`template.html` e Contratación) dependem do
   orquestrador que devolve `handoff`, `REASSIGN_REQUIRED`, `final`, `NOT_PDF` e `DUPLICATE_OPEN`: publique-os **depois** do deploy desse
   servidor. Com um servidor antigo, a página não reatribui mais ao abrir e o `/start` responde 409 ("La tarea no está asignada
   al usuario de integración."). O WebReport antigo de Contratación (REASSIGN na renderização) segue funcionando com o servidor
   novo, mas continua com o defeito do incidente: só some ao publicar o novo.
3. **Testar um envio** em cada WebReport (checklist abaixo) e conferir nos logs que não há mais `warn` de uso legado.
4. **Desligar as flags** (`START_LEGACY_GET_ENABLED=false`, `START_LEGACY_SIGNATURE=false`, ou removê-las): `GET /auth` e
   `GET /start` passam a responder 404 e a assinatura v1 é rejeitada (403).

Rollback: religar as flags e republicar o WebReport antigo.

## Checklist de teste em QA

- [ ] Workflow de contratação (sub-fluxo) na tarefa "Enviar solicitud de firma": abrir o WebReport 702040 e ver
      "Documento enviado" (ou a mensagem do servidor). Conferir no Adobe o acordo, os e-mails e o nome do documento.
- [ ] Na tabela de acordos (`/admin/agreements`), o registro tem `workflowId`/`subworkflowId` **reais** (não o WFID do pai)
      e `taskId = 2`; o `externalId` no Adobe é `otcs|wf=<workflow>|sub=<subworkflow>|node=<DocID>|attach=<AttachID>`.
- [ ] A tarefa de início avança sozinha (SendOn) e a "Aguardar Firma" fica ativa.
- [ ] Recarregar a página do WebReport: aparece "Signature already requested. ID: ..." e **não** nasce outro acordo.
- [ ] Repetir no fluxo puro (650835 / `template.html`).
- [ ] Tarefa reatribuída ao usuário de integração (AdminKeralty, o ID da linha `WFTASKACTION:REASSIGN`) depois do envio
      (e não ao Stiven).
- [ ] Fluxo fora do passo de envio (tarefa já concluída): mensagem "El flujo no está en el paso de envío a firma." (409).
- [ ] Formulário sem e-mails ou sem DocID: erro 422 legível na página.
- [ ] No navegador (DevTools): `OPTIONS /auth` e `/start` respondem com `Access-Control-Allow-Origin` igual à origem do
      OTCS; de qualquer outra origem, sem esse cabeçalho.
- [ ] Logs do orquestrador sem `warn` de "Assinatura v1" / "GET /start (contrato antigo" após o rollout.
- [ ] `template.html`, ramo reasignar: abrir `…?func=ll&objAction=RunReport&objId=650835&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar`
      logado com um usuário que tenha a tarefa. A resposta traz `REASIGNADO_OK` e a tarefa passa ao usuário da linha
      `WFTASKACTION:REASSIGN`. Isso prova que `&ACCION`, `&WORKID`, `&SUBWORKID` e `&TASKID` resolvem no ramo `reasignar`.
- [ ] `template.html`, forma entre aspas: `[LL_REPTAG_{'[LL_REPTAG_&WORKID /]',...} ...]` resolve para os três IDs (não o texto
      literal das tags). Confirmar no OTCS que a tarefa foi para o ID da linha `WFTASKACTION:REASSIGN`.
- [ ] `template.html`, confirmação: com uma cópia do WebReport apontando a linha `WFTASKACTION:REASSIGN` para um usuário que
      não é o de integração, a página mostra "No fue posible asignar la tarea" e **não** mostra "Listo".
- [ ] `template.html`: `REPORT_ID` do bloco de configuração é o ID do WebReport publicado, e `[LL_REPTAG_URLPREFIXFULL /]` devolve a base do CGI, sem
      barra no final (ex.: `https://host/cs/cs`). O link "Ver documento" abre o documento.
- [ ] `template.html`, reabrir: fechar a página depois do `/start` com `assigned: false` e antes da reatribuição; ao reabrir,
      a página responde `existing: true`, reatribui, confirma e envia.
- [ ] `template.html`: nome de documento com apóstrofo (ex.: `Ana's`) aparece certo e o envio funciona. Nome com
      `<img src=x onerror=...>` aparece como texto e não cria elemento.
- [ ] `template.html`: sem `REASIGNADO_OK` na página normal (abrir a URL do WebReport sem `accion`).

Contratación (702040 em QA, 796139 em PROD) e comportamento novo do servidor, nas **duas** páginas:

- [ ] Contratación, ramo reasignar: abrir `…?func=ll&objAction=RunReport&objId=702040&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar`
      com um usuário que tenha a tarefa: a resposta contém `REASIGNADO_OK` e a tarefa passa ao usuário da linha
      `WFTASKACTION:REASSIGN`. A forma entre aspas com `&TASKID` ainda precisa ser confirmada neste WebReport (o 702040 usava a
      tarefa `2` fixa); `REPORT_ID` do bloco de configuração é o ID do WebReport publicado.
- [ ] Contratación, página normal (sem `accion`): **não** reatribui ao abrir. A tarefa só muda de usuário depois do acordo criado
      (ver no OTCS: com `NOT_PDF` a tarefa continua com o usuário humano).
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
