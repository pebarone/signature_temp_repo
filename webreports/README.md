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
2. `POST /start` com os mesmos campos + `taskId`, `timestamp`, `nonce`, `signature`.

O orquestrador não confia no navegador: com `START_VERIFY_WORKFLOW=true` (padrão) ele consulta o workflow no OTCS,
exige que a tarefa "Enviar solicitud de firma" esteja ativa e usa `DocID`, `AttachID`, `Nombre del Documento` e os
e-mails (`Email Firmante 1/2`) **do formulário da tarefa**. Se o que o navegador mandou diverge, responde 409.
Reabrir/recarregar a página depois de um envio já feito devolve o mesmo acordo (200, `existing: true`), sem criar outro.

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

## Usuário de integração (REASSIGN)

Os dois WebReports reatribuem a tarefa de envio ao usuário de integração (`WFTASKACTION:REASSIGN:<id>`), o mesmo da
variável `OTCS_USER` do orquestrador. Antes era o usuário nominal do Stiven (279463 em QA, 306309 em PROD); agora é o
**AdminKeralty**:

- QA: `11742766` (já nos arquivos).
- PROD: **a confirmar** (ID do AdminKeralty de PROD). Troque o número `11742766` no `REASSIGN` antes de publicar em PROD.

O comentário `[// ... /]` no topo de cada arquivo lembra disso. A reatribuição é necessária porque o orquestrador lê o
formulário da tarefa (GET) e faz o SendOn com esse usuário: se a tarefa não estiver com ele, `/start` responde 409
("La tarea no está asignada al usuario de integración.").

## O que muda em PROD

1. `SERVER_URL`: a URL da Route do orquestrador em OpenShift (hoje os arquivos têm a de QA no Render,
   `https://signature-orchestrator-api-2gim.onrender.com`).
2. O ID do AdminKeralty de PROD no `REASSIGN`.
3. O link do OTCS de PROD em `docLink` (a constante `url`, hoje com `https://otcs.g115-test.opentext.cloud/...`; PROD é
   `https://otcs.g115.opentext.cloud/...`). O link "Volver a Smartview" do fluxo puro (`template.html`) também aponta para o
   SuccessFactors de preview; confirmar o de PROD.
4. Usuário/senha Basic dos WebReports (`BASIC_USER`/`BASIC_PASS` em `startProcess`): devem ser iguais a
   `START_AUTH_USER`/`START_AUTH_PASS` do orquestrador (ou, sem elas, `LOG_USER`/`LOG_PASS`). Recomenda-se usar credencial
   própria do WebReport (o texto fica visível a quem abre a página; ela só serve para `/auth`, não abre `/admin` nem `/logs`).
5. `CORS_ORIGINS` do orquestrador: o padrão é a origem de `OTCS_BASE` (`https://otcs.g115.opentext.cloud` em PROD). Se o
   WebReport for servido de outra origem, liste-a.

## Ordem de rollout (sem janela de erro)

1. **Deploy do orquestrador** com as flags de transição ligadas: `START_LEGACY_GET_ENABLED=true` e
   `START_LEGACY_SIGNATURE=true`. Os WebReports antigos (GET sem HMAC / HMAC só do timestamp) continuam funcionando, agora
   sempre validados contra o OTCS; cada uso gera `warn` no log pedindo a atualização.
2. **Publicar os WebReports novos** (um por vez, QA antes de PROD).
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
- [ ] Tarefa reatribuída ao AdminKeralty (11742766) depois de abrir o WebReport (e não ao Stiven).
- [ ] Fluxo fora do passo de envio (tarefa já concluída): mensagem "El flujo no está en el paso de envío a firma." (409).
- [ ] Formulário sem e-mails ou sem DocID: erro 422 legível na página.
- [ ] No navegador (DevTools): `OPTIONS /auth` e `/start` respondem com `Access-Control-Allow-Origin` igual à origem do
      OTCS; de qualquer outra origem, sem esse cabeçalho.
- [ ] Logs do orquestrador sem `warn` de "Assinatura v1" / "GET /start (contrato antigo" após o rollout.

## Página "Revisar y enviar a firma" (mapa Firma 650736)

Arquivo: `Revisar y enviar a firma.html`. Vale **só** para o mapa Firma standalone (650736) por enquanto. O fluxo puro
(`template.html`) e os sub-fluxos de contratação continuam como estão. Publique como WebReport novo (o nó é definido em
QA e em PROD).

O mapa passa a ter duas tarefas antes da assinatura:

1. **Revisar y enviar a firma** (tarefa humana): mostra o link do documento e os e-mails dos firmantes. Nada é enviado
   ao abrir.
2. **Enviar solicitud de firma** (tarefa do usuário de integração): atribuída **no próprio mapa** a esse usuário. A
   página não usa REASSIGN. É o passo que o orquestrador lê para criar o acordo.

Ao clicar em **Enviar a firma**:

1. Chama a mesma página com a sessão OTCS do usuário (`credentials: 'same-origin'`):
   `OTCS_URL?func=ll&objAction=RunReport&objId=<REPORT_ID>&workid=…&subworkid=…&taskid=…&accion=avanzar`.
   O ramo `accion=avanzar` roda `WFTASKACTION:SENDON` na tarefa atual e responde o marcador `AVANZADO_OK` (a página normal não contém esse texto literal).
2. `POST /auth` + `POST /start` (protocolo v2), como nas outras páginas. Até 4 tentativas, com 1,5 s entre elas, cada uma
   com assinatura nova. Só repete em **409** (a tarefa de integração pode ainda não estar ativa). O `/start` não leva
   `taskId`: o orquestrador acha a tarefa de envio pelo nome, no OTCS.
3. Sucesso (inclusive `existing: true`): mensagem do servidor e botão "Volver a Smartview". Erro: mensagem do servidor e
   botão "Reintentar envío", que repete só o passo 2.

### Configuração por ambiente

Só estes valores mudam, no bloco **CONFIGURACAO DO AMBIENTE** no topo do script:

| Constante | QA | PROD |
|---|---|---|
| `SERVER_URL` | `https://signature-orchestrator-api-2gim.onrender.com` | Route do orquestrador no OpenShift |
| `BASIC_USER` / `BASIC_PASS` | placeholders `ADOBE-LOGS` / `ADOBE-LOGS-PASS` | iguais a `START_AUTH_USER` / `START_AUTH_PASS` do orquestrador de PROD |
| `RETURN_URL` | SuccessFactors de preview (`hcm41preview.sapsf.com`) | confirmar o de PROD |

Os demais vêm do OTCS pelas tags do WebReport: IDs e atributos (`DocID`, `AttachID`, `Nombre del Documento`, e-mails),
`OTCS_URL` (`[LL_REPTAG_URLPREFIXFULL /]`) e `REPORT_ID` (`[LL_REPTAG_REPORTID /]`). Por isso a página não traz URL de
OTCS nem ID de usuário fixo. Como nos outros WebReports, `BASIC_USER`/`BASIC_PASS` ficam visíveis a quem abre a página.

### Confirmar em QA antes de publicar

- `&TASKID` e `&ACCION` resolvem na página normal e no ramo `accion=avanzar` (a URL passa `taskid` e `accion`). A página
  só funciona se `&TASKID` trouxer o ID da tarefa humana atual.
- `[LL_REPTAG_REPORTID /]` existe e traz o ID do WebReport publicado (é o `objId` do `RunReport`).
- O `SENDON` da tarefa humana leva o acordo para "Enviar solicitud de firma". Confira nos passos do workflow e no acordo
  criado.
- A tarefa "Enviar solicitud de firma" já está com o usuário de integração antes do teste (QA: 11742766; PROD: o ID do
  AdminKeralty de PROD).

### Limitações conhecidas

- O marcador `AVANZADO_OK` do avanço só confirma que o ramo `avanzar` rodou (e não a página de login de uma sessão
  expirada). Se o `SENDON` falhar sem erro HTTP, o `/start` responde 409 e a página mostra a mensagem, sem avançar sozinha.
- O avanço é um GET autenticado só pelo cookie da sessão do OTCS. Um link ou `<img>` com a URL `accion=avanzar` aberto
  pelo responsável da tarefa avançaria a etapa sem o clique (risco de CSRF limitado à própria tarefa; o `template.html`
  atual já envia ao abrir).
- A flag `advanced` vive só na página. Recarregar depois do avanço faz o botão voltar a "Enviar a firma", e um clique
  repetiria o `SENDON` numa tarefa humana já concluída. O `/start` é idempotente por workflow (`existing: true`), então o
  acordo não duplica, mas o `SENDON` pode falhar ou atuar em outra tarefa. Pendência: checar no carregamento se a tarefa
  humana ainda está ativa antes de liberar o botão.
