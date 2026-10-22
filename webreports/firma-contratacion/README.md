# WebReport "Requisicion de Firma_Contratacion" (sub-fluxos de contratação)

Página: [`Requisicion de Firma_Contratacion.html`](Requisicion%20de%20Firma_Contratacion.html) (antes em `webreports/`).
Índice, protocolo v2 (`/auth` + `/start`), regra de reatribuição, tabela de respostas do `/start`, rollout e checklist comum:
[`../README.md`](../README.md).

| | QA | PROD |
|---|---|---|
| Nó do WebReport (`REPORT_ID`) | 702040 | 796139 |
| Usuário de integração (linha `WFTASKACTION:REASSIGN`) | 11742766 (AdminKeralty) | a confirmar |

Os atributos do formulário (`DocID`, `AttachID`, `Nombre del Documento`, `Email Firmante 1/2`) estão no **sub-fluxo**, por isso a
página os lê com `&SUBWORKID WFATTR:"..."` (a fonte antiga do 702040 lia com `&WORKID`). Detalhe em "Por que `&WORKID` e
`&SUBWORKID`" no [`../README.md`](../README.md#por-que-workid-e-subworkid).

## O que mudou nesta página (702040 em QA, 796139 em PROD)

- **Saiu** o `WFTASKACTION:REASSIGN` da linha 3, que rodava **na renderização**, antes de qualquer acordo. Agora o arquivo é
  `[LL_WEBREPORT_IF "&ACCION" == "reasignar"] ... [LL_WEBREPORT_ELSE] <página> [LL_WEBREPORT_ENDIF]`, como a página do fluxo puro. O ramo
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

## O que mudar por ambiente (PROD)

Dois lugares: o bloco **CONFIGURACAO POR AMBIENTE** no topo do script e a linha `WFTASKACTION:REASSIGN` do ramo `reasignar`.
Os itens comuns (`SERVER_URL`, usuário de integração, Basic, CORS) estão em
[`../README.md`](../README.md#o-que-muda-em-prod-comum). Específicos desta página:

1. `REPORT_ID` vira `796139` em PROD (QA: `702040`).
2. O ID do usuário de integração também está fixo na linha `WFTASKACTION:REASSIGN` do ramo `reasignar` (QA `11742766`; PROD a confirmar).
3. Link "Abrir documento": trocar o host de teste fixo (`otcs.g115-test.opentext.cloud`) pelo de PROD.

## Checklist de QA (702040 em QA, 796139 em PROD)

- [ ] Workflow de contratação (sub-fluxo) na tarefa "Enviar solicitud de firma": abrir o WebReport 702040 e ver
      "Documento enviado" (ou a mensagem do servidor). Conferir no Adobe o acordo, os e-mails e o nome do documento.
- [ ] Na tabela de acordos (`/admin/agreements`), o registro tem `workflowId`/`subworkflowId` **reais** (não o WFID do pai)
      e `taskId = 2`; o `externalId` no Adobe é `otcs|wf=<workflow>|sub=<subworkflow>|node=<DocID>|attach=<AttachID>`.
- [ ] A tarefa de início avança sozinha (SendOn) e a "Aguardar Firma" fica ativa.
- [ ] Recarregar a página do WebReport: aparece "Signature already requested. ID: ..." e **não** nasce outro acordo.
- [ ] Ramo reasignar: abrir `…?func=ll&objAction=RunReport&objId=702040&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar`
      com um usuário que tenha a tarefa: a resposta contém `REASIGNADO_OK` e a tarefa passa ao usuário da linha
      `WFTASKACTION:REASSIGN`. A forma entre aspas com `&TASKID` ainda precisa ser confirmada neste WebReport (o 702040 usava a
      tarefa `2` fixa); `REPORT_ID` do bloco de configuração é o ID do WebReport publicado.
- [ ] Página normal (sem `accion`): **não** reatribui ao abrir. A tarefa só muda de usuário depois do acordo criado
      (ver no OTCS: com `NOT_PDF` a tarefa continua com o usuário humano).

Os itens do checklist comum (NOT_PDF, acordo final, DUPLICATE_OPEN, tarefa reatribuída, CORS, logs) também valem aqui: ver
[`../README.md`](../README.md#checklist-comum-de-qa-servidor-e-protocolo).
