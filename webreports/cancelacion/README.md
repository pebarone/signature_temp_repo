# WebReport "Cancelar Flujo de Firma" (cancelamento)

Página: [`Cancelar Flujo de Firma.html`](Cancelar%20Flujo%20de%20Firma.html) (nova; ticket 2026060410003715).
Modelo: [`../firma-flujo-puro/Requisicion de Firma.html`](../firma-flujo-puro/Requisicion%20de%20Firma.html) (mesma estrutura, mesmo
bloco de configuração, mesmo ramo `reasignar`, mesmo estilo). Protocolo v2 e regra de reatribuição: [`../README.md`](../README.md).
Contrato do servidor (`POST /cancel`, códigos de resposta, o que falta do lado Content):
[`../../docs/DESIGN_TICKET_2026060410003715.md`](../../docs/DESIGN_TICKET_2026060410003715.md).

| | QA | PROD |
|---|---|---|
| Nó do WebReport (`REPORT_ID`) | a criar (placeholder `REPORT_ID_POR_ASIGNAR` na página) | a criar |
| Usuário de integração (linha `WFTASKACTION:REASSIGN`) | 11742766 (AdminKeralty) | ID do AdminKeralty de PROD |

## O que a página faz

Roda na tarefa **"Cancelar Flujo de Firma"** do workflow de cancelamento (nome em `CANCEL_TASK_NAMES` do servidor).

1. Ao abrir, **não chama o servidor**. Lê os atributos da tarefa `ID Flujo a Cancelar` e `ID Subflujo a Cancelar`
   (`&SUBWORKID WFATTR:"..."`, em `<textarea>` ocultos como a página do fluxo puro) e os **mostra** para o usuário confirmar,
   com o aviso de que cancelar **perde qualquer assinatura parcial**.
   Se o ID do fluxo não é numérico (o WebReport mostra `?` quando vazio) ou o subflujo não é numérico, mostra o erro e **não** oferece o botão.
2. O botão **Cancelar flujo** faz `POST /auth` `{workflowId, subworkflowId}` (o workflow de **cancelamento**: `&WORKID`/`&SUBWORKID`)
   e `POST /cancel` `{workflowId, subworkflowId, timestamp, nonce, signature}`. O fluxo a cancelar **não viaja** no corpo: o servidor
   o lê do formulário da tarefa; o que a página mostra é só informativo.
3. `409 REASSIGN_REQUIRED` (com `handoff`): reatribui pelo ramo `accion=reasignar` (mesmo ramo e mesma função da página do fluxo
   puro) e repete `/auth` + `/cancel` **uma vez**; se responder `REASSIGN_REQUIRED` de novo, mostra "No fue posible asignar la tarea".
4. O servidor, com o acordo cancelado, faz o SendOn da tarefa. Por isso não há passo de "confirmar atribuição" depois.

### Respostas e mensagens (tudo em espanhol na página)

| Resposta | Mensagem da página | Reintentar |
|---|---|---|
| `200 { id, alreadyCancelled: false }` | "Flujo cancelado en Adobe Sign. El flujo de cancelación continúa." + ID do acordo | — |
| `200 { id, alreadyCancelled: true }` | "El acuerdo ya estaba cancelado en Adobe Sign. El flujo de cancelación continúa." + ID | — |
| `404 AGREEMENT_NOT_FOUND` | "No se encontró un acuerdo de firma para este flujo." + dica (acordo do orquestrador antigo: soporte adota com `POST /admin/adopt/{id}`) | sim |
| `404 AGREEMENT_NOT_FOUND_IN_ADOBE` | "El acuerdo ya no existe en Adobe Sign..." | não |
| `409 AMBIGUOUS` | "El flujo tiene más de un acuerdo de firma abierto. No se canceló ninguno." + **lista** (id, subflujo, documento, estado, criado) | não |
| `409 AGREEMENT_CLOSED` | "El acuerdo más reciente de este flujo ya concluyó; no hay nada que cancelar." + resumo do acordo | não |
| `409 ALREADY_SIGNED` | "El acuerdo ya fue firmado por todos en Adobe Sign; no se puede cancelar." | não |
| `409 ALREADY_REJECTED` | "Un firmante ya rechazó el acuerdo en Adobe Sign; no se puede cancelar. El flujo original recibirá el rechazo." | não |
| `409 NOT_CANCELABLE` | "El acuerdo está en un estado en el que Adobe Sign no permite cancelarlo." + `Estado en Adobe Sign: <adobeStatus>` | não |
| `409 IN_PROGRESS` | "Ya hay una cancelación en curso para este acuerdo..." | sim |
| `409 NOT_AT_CANCEL_STEP` | "El flujo de cancelación no está en el paso ..." | não |
| `409 FLOW_NOT_FOUND` | "No se encontró el flujo de cancelación en Content Server." | não |
| `409 REASSIGN_REQUIRED` | reatribui e repete uma vez (ver acima); sem `handoff`: "No fue posible asignar la tarea." | sim |
| `422 MISSING_TARGET` / `INVALID_TARGET` | pede completar/corrigir o atributo `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` | não |
| `503 ADOBE_UNAVAILABLE` / `OTCS_UNAVAILABLE` / `RECONCILE_IN_PROGRESS` | "... No se modificó nada; intente nuevamente." | sim |
| `503 SENDON_FAILED` | "El acuerdo ya fue cancelado en Adobe Sign, pero no se pudo continuar el flujo de cancelación." + "Repetir es seguro" | sim |
| `404` sem `code` | "La cancelación de flujos no está habilitada en el servidor." (`CANCEL_ENABLED=false`) | não |
| `500`, `400/401/403` sem `code`, outros | mensagem do servidor (ou texto padrão) | sim |
| falha de rede | "No se pudo conectar con el servidor de firmas." | sim |

`AGREEMENT_NOT_FOUND_IN_ADOBE` não está na tabela do design, mas o serviço o emite (`cancellationService.js`), então a página o trata.

## O que mudar por ambiente (PROD)

Dois lugares: o bloco **CONFIGURACAO POR AMBIENTE** no topo do script e a linha `WFTASKACTION:REASSIGN` do ramo `reasignar`.
Os itens comuns (`SERVER_URL`, usuário de integração, Basic, CORS) estão em
[`../README.md`](../README.md#o-que-muda-em-prod-comum). Específicos desta página:

1. `REPORT_ID`: ID do nó do WebReport no ambiente. No repositório fica o placeholder `REPORT_ID_POR_ASIGNAR` (não é numérico:
   enquanto não for trocado, a reatribuição falha com "Datos de reasignación inválidos" em vez de chamar um relatório errado).
2. `BASIC_USER`/`BASIC_PASS`: placeholders `ADOBE-LOGS`/`ADOBE-LOGS-PASS`, iguais aos das outras páginas; o valor real só entra no WebReport publicado.
3. Os nomes dos atributos lidos (`ID Flujo a Cancelar`, `ID Subflujo a Cancelar`) estão nas duas tags `WFATTR` do HTML e devem ser
   **iguais** a `CANCEL_FIELD_TARGET_WORKFLOW` / `CANCEL_FIELD_TARGET_SUBWORKFLOW` do servidor (nomes provisórios). Mudou um lado, mude o outro.
4. A página não tem botão de retorno nem `RETURN_URL` (o cancelamento não parte do SuccessFactors): ao terminar, diz que pode fechar a janela.

## Checklist de QA

Roteiro do design (acordo de teste `OUT_FOR_SIGNATURE`). Nada disto foi validado no OTCS ainda.

- [ ] Servidor com `CANCEL_ENABLED=true` e o WebReport publicado (com `CANCEL_ENABLED=false`, o clique mostra "no está habilitada").
- [ ] Ao abrir, a página mostra os valores de `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` (`[LL_REPTAG_&SUBWORKID WFATTR:"...":DISPLAY /]`
      resolve) e **não** faz nenhum pedido ao servidor antes do clique (DevTools, aba Network).
- [ ] Atributo vazio (o OTCS mostra `?`): erro "no tiene el ID del flujo a cancelar", sem botão.
- [ ] Cancelar um acordo `OUT_FOR_SIGNATURE`: acordo `CANCELLED` no Adobe, SendOn da tarefa de cancelamento, fluxo original **sem**
      `Rechazado` indevido (o `AGREEMENT_RECALLED` não gera disposição).
- [ ] Repetir (idempotência): segundo clique/recarga mostra "ya estaba cancelado" (200 `alreadyCancelled`) ou `NOT_AT_CANCEL_STEP` se a tarefa já avançou.
- [ ] Fluxo ambíguo (dois acordos abertos): lista os acordos e não cancela nenhum.
- [ ] Fluxo já assinado: "ya fue firmado", nada cancelado.
- [ ] Tarefa ainda com o usuário humano: `REASSIGN_REQUIRED` → reatribui pelo ramo `reasignar` (resposta `REASIGNADO_OK`) → repete e cancela.
      Ramo `reasignar`: abrir `…?func=ll&objAction=RunReport&objId=<REPORT_ID>&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar` e conferir.
- [ ] `SENDON_FAILED` (simular no QA): a página avisa que o acordo já foi cancelado e Reintentar conclui sem cancelar de novo.
- [ ] Sem `REASIGNADO_OK` na página normal (abrir a URL do WebReport sem `accion`).

## Pendiente

Pontos em que a página precisaria de algo que o servidor ou o mapa do Content ainda não fazem. Nada foi inventado na página:

- **Nó do WebReport e mapa do workflow de cancelamento não existem no Content** (ver "O que falta do lado Content" no design):
  atributos `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` no formulário, tarefa com o nome de `CANCEL_TASK_NAMES`, tarefa seguinte que
  cancela o fluxo original. `REPORT_ID` é placeholder até publicar.
- **Aviso de assinatura parcial é genérico.** O `/cancel` não informa, antes de cancelar, quem já assinou nem o estado do acordo
  (ponto 4 de "Em aberto" do design). Para mostrar "Fulano já assinou" o servidor precisaria de uma consulta prévia (sem efeito); hoje a
  página só avisa que a assinatura parcial se perde.
- **A página não valida o fluxo alvo no OTCS** (existe? está em "Aguardar Firma"?): o design deixa isso aberto ("Quem informa o ID e como é
  validado"). Só o servidor responde `AGREEMENT_NOT_FOUND`/`AGREEMENT_CLOSED` depois do clique.
- **`AMBIGUOUS` não é resolvível na página.** O servidor só aceita o subflujo vindo do atributo do formulário; a página lista os acordos
  e pede corrigir `ID Subflujo a Cancelar` e abrir de novo (os valores mostrados são lidos no carregamento). Escolher o acordo na página
  exigiria o servidor aceitar um alvo vindo do navegador, o que ele ignora de propósito.
- **`AGREEMENT_NOT_FOUND`** de acordos do orquestrador antigo: a dica (adoção via `POST /admin/adopt/:id`, rota administrativa) é só
  texto; não há como adotar pela página.
- **Reabrir a página depois da reatribuição:** a tarefa sai do usuário humano; se ele recarregar a página antes do cancelamento
  concluir, a leitura de `WFATTR`/`NOT_AT_CANCEL_STEP` depende de permissões do OTCS que não foram validadas.
- **Não validado:** todo o comportamento das tags OTCS (`WFATTR`, `&ACCION`, forma entre aspas do `WFTASKACTION:REASSIGN`,
  `URLPREFIXFULL`) é herdado da página do fluxo puro, mas só se confirma no QA. A página também não foi executada contra o servidor real:
  só foi verificada a sintaxe do script e uma simulação com DOM/`fetch` falsos.
- `PUT /agreements/{id}/state` do Adobe, `notifyOthers` e o evento `AGREEMENT_RECALLED` seguem pendentes de validação no QA (ponto 13 de "Em aberto").
