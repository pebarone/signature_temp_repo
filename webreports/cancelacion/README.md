# WebReport de cancelamento (`webreports/cancelacion/`)

Ticket 2026060410003715 (cancelamento de fluxos, em lote). Desenho e contrato do servidor:
[`../../docs/DESIGN_TICKET_2026060410003715.md`](../../docs/DESIGN_TICKET_2026060410003715.md). Protocolo v2 e regra de
reatribuição: [`../README.md`](../README.md). Nada daqui foi publicado nem executado no OTCS ainda.

| Arquivo | O que é | Fala com o orquestrador? |
|---|---|---|
| [`Cancelar Flujo de Firma.html`](Cancelar%20Flujo%20de%20Firma.html) | **página única**, com **dois modos**. Modo tarefa: a tarefa "Cancelar Flujo de Firma" (`CANCEL_TASK_NAMES`): seleção, gravação, revisão e cancelamento. Modo direto: o WebReport executado sozinho, sem workflow (ver "Modo direto") | sim: `/auth`, `/cancel/preview`, `/cancel` (tarefa); `/cancel/direct/auth`, `/cancel/direct/preview`, `/cancel/direct` (direto) |
| [`Cancelar Flujo de Firma.sql`](Cancelar%20Flujo%20de%20Firma.sql) | LiveReport que alimenta a etapa de seleção (fonte de dados do WebReport) | não |
| [`Cancelar Flujo de Firma - diagnostico.sql`](Cancelar%20Flujo%20de%20Firma%20-%20diagnostico.sql) | LiveReport de diagnóstico, só leitura e sem parâmetros: confere no destino as premissas da query acima | não |

Modelo da página: [`../firma-flujo-puro/Requisicion de Firma.html`](../firma-flujo-puro/Requisicion%20de%20Firma.html)
(mesma estrutura, mesmo bloco de configuração, mesmo ramo `reasignar`, mesmo estilo).

## Mapa do workflow (uma tarefa)

`Início → "Cancelar Flujo de Firma" → Fim`. A tarefa roda o WebReport. O formulário dela tem `ID Flujo a Cancelar` (multivalor),
`ID Subflujo a Cancelar` (opcional) e `IDs Cancelados` (multivalor, gravado pelo lote). Com `CANCEL_STOP_ORIGINAL=false` (padrão)
há um passo extra, "Detener flujos originales", entre a tarefa e o Fim; com `true` ele não é necessário (ver abaixo).

## Fluxo da página

Um só WebReport com ramos por `accion`: `guardar`, `leer` e `reasignar` (cada um só roda com a sua `accion`); sem `accion`, mostra a
página (ELSE). Fonte de dados = o LiveReport. As etapas ficam na mesma página, nesta ordem.

**Ao abrir**, a página lê `ID Flujo a Cancelar` (`WFATTR`, em `<textarea>` oculto) e **não chama o servidor**:
- atributo **vazio** (o OTCS mostra `?`): vai para a etapa A;
- atributo **com IDs** (reabertura, por exemplo pendentes de um lote anterior, ou IDs colados à mão): mostra os IDs e oferece
  **"Revisar flujos"** (direto para a etapa C, sem regravar) e **"Cambiar selección"** (etapa A, já com esses IDs marcados).

**A. Buscar e marcar.** O LiveReport traz todas as tarefas "Aguardar Firma" ativas (sub-fluxos de firma) e a página filtra na
hora, sem recarregar. **Por padrão só aparecem os fluxos que ainda precisam ser cancelados**: some o WorkID cujo processo
(`EstadoFlujo`) tem status negativo, ou cujos sub-fluxos de firma listados (`EstadoSubflujo`) têm todos status negativo (-1 concluído, -2 parado). Ao parar o
processo, o OTCS deixa o sub-fluxo em 1 e a tarefa "Aguardar Firma" em 2, então sem esse corte os fluxos já cancelados (Adobe e
Content) continuavam na lista. Uma nota diz quantos ficaram ocultos, e a caixa "Incluir flujos ya detenidos o concluidos" (desmarcada
por padrão; "Limpiar filtros" a desmarca) mostra todos. Cancelado só no Adobe, com o stop pendente (`STOP_FAILED` ou passo "Detener
flujos originales" ainda não executado), continua aparecendo: falta parar no Content. Status vazio ou não numérico (LiveReport ainda
sem a coluna 9) conta como aberto. Filtros: flujo (WorkID ou SubWorkID), empregado (login), nome, documento (contém, sem distinguir maiúsculas nem
acentos), desde e hasta (início do sub-fluxo, inclusivos); vazio = sem filtro. Empregado, nome, documento e DocID saem do JSON
de atributos com os `wf_attrid` de `ATRIBUTOS_FIRMA` (4, 7, 6, iguais em todos os clones do mapa Firma). Quando o Empleado
(4) vem vazio, como nos `Firma_Contratación_Inactivo` do QA, a coluna e o filtro de empregado usam o Email Firmante 1 (10). Tabela com
checkboxes, "Seleccionar todos" e contador "Seleccionados: N de 20" (`MAX_FLUJOS`; passando dele a página não deixa marcar mais).
A seleção fica em sessionStorage entre buscas (sem ele, só em memória). Um aviso diz que a revisão pode transferir a tarefa ao
usuário de integração.

**B. Gravar e conferir (antes de qualquer chamada ao servidor).** "Revisar N flujos" abre um modal com a lista; ao aceitar:
1. valida no cliente (só dígitos, 1 a `MAX_FLUJOS`, sem repetidos);
2. ramo `accion=guardar&ids=1,2,3` (`WFACTION:REMOVEATTR:...:ALL` e `WFACTION:SETATTR:MV:"ID Flujo a Cancelar":1:<ids>`, um
   valor com os IDs separados por vírgula), resposta `GUARDADO_OK`;
3. ramo `accion=leer` (só leitura): `LEIDO_OK` seguido dos valores do atributo, que devem ser **exatamente** os IDs enviados.
Se a seleção for igual ao que já está gravado, a página não regrava. Só segue se a verificação bater.
**Plano C** (falha, resposta sem confirmação, valor diferente ou não verificável): a página **não chama o servidor**, mostra os IDs e
"Copiar IDs", e pede para colá-los no campo `ID Flujo a Cancelar` do formulário, guardar o formulário e recarregar a tarefa (F5):
ao reabrir, a página mostra os IDs gravados e oferece a revisão.

**C. Revisar.** `POST /auth` (workflow de cancelamento) e `POST /cancel/preview`; nada é cancelado nem gravado. Grupos:
- **Se cancelarán**: `cancelable: true` (`abierto`, `firma_parcial`, `ya_cancelado`). Firma parcial mostra o aviso, a quantidade de
  firmas e a data da última;
- **Firmados — regularizar, no cancelar** (bloco destacado): `firmado`;
- **No se cancelarán**: os demais, com o motivo (`rechazado`, `no_cancelable`, `concluido`, `ambiguo`, `no_encontrado`,
  `no_existe_en_adobe`);
- **No se pudieron revisar**: `no_disponible` e `pendiente`, com "Revisar de nuevo";
- `resultFieldMissing: true`: erro de configuração (falta `IDs Cancelados` no formulário); não há botão de confirmar;
- `subworkflowIgnored: true`: nota de que o subflujo foi ignorado;
- `stopOriginal`: ajusta o texto de confirmação (ver "Parada do fluxo original").
A prévia também oferece **"Cambiar selección"**.

**D. Confirmar e cancelar.**
- Com algum `firma_parcial`, o checkbox de ciência é obrigatório (o botão fica bloqueado até marcá-lo).
- Botão "Cancelar estos N flujos", ou "Continuar sin cancelar ninguno" quando N é 0. Aviso: o servidor relê o atributo e processa
  **todos** os fluxos da lista, não só os cancelables da prévia.
- `POST /auth` e `POST /cancel`. Resultado item a item, com `contentStop`. Com `complete: false`, "Reintentar pendientes" repete a
  partir de um `/auth` novo (idempotente no servidor). Com `complete: true`, a tarefa continua e a página diz que pode fechar a janela.

**Reatribuição.** `409 REASSIGN_REQUIRED` (com `handoff`) na prévia ou no cancelamento dispara o ramo `accion=reasignar` (linha
`WFTASKACTION:REASSIGN`) e repete a chamada uma vez, com `/auth` novo. Se falhar de novo: "No fue posible asignar la tarea".
**A revisão transfere a tarefa ao AdminKeralty** quando ela ainda estava com o usuário: a página avisa (na etapa A, no modal e na
prévia) para não fechar até terminar; fechar antes deixa a tarefa com o AdminKeralty.

**Risco de "Cambiar selección" depois da revisão (VALIDAR NO QA).** Com a tarefa já no AdminKeralty, o usuário humano pode não ter
mais permissão para gravar o atributo: o ramo `guardar` falha (ou o valor não muda) e a página cai no plano C com a explicação.
Nesse caso é preciso colar os IDs à mão (se o formulário ainda permitir) ou pedir ao AdminKeralty/soporte que ajuste a tarefa.
Mudar a seleção antes da primeira revisão não tem esse problema.

## Modo direto (WebReport executado sozinho, sem workflow)

O mesmo HTML tem **dois modos**. O script olha `WORKID`, `SUBWORKID` e `TASKID`:
- os **três só dígitos** → modo tarefa;
- os **três sem resolver** (vazios depois de `trim`, ou ainda com o texto da tag: `LL_REPTAG`, `WORKID`, `TASKID`, `&`, colchetes) → modo direto;
- **qualquer mistura** (por exemplo uma URL com `workid` e `subworkid` mas **sem `taskid`**) → **estado de erro**: "Datos de la tarea inválidos: abra esta página desde la tarea...", sem botões e **sem chamar `/auth` nem `/cancel*`** (não falha aberto).

Fora de uma tarefa o OTCS entrega essas tags vazias ou sem resolver; as duas coisas caem no modo direto (**validar no QA** como ele as renderiza).

| | Modo tarefa (descrito acima) | Modo direto |
|---|---|---|
| Como abre | tarefa "Cancelar Flujo de Firma" do workflow de cancelamento | o WebReport sozinho (URL `RunReport`, menu...), sem workflow |
| Alvos | gravados em `ID Flujo a Cancelar`; o servidor os relê do formulário | vão no corpo (`targetWorkflowIds`) e ficam **vinculados ao HMAC** |
| Rotas | `/auth`, `/cancel/preview`, `/cancel` | `/cancel/direct/auth`, `/cancel/direct/preview`, `/cancel/direct` |
| Credencial Basic do pedido de assinatura | `START_AUTH_*` (ou `LOG_*`), em `BASIC_USER`/`BASIC_PASS` | **a mesma**, em `BASIC_USER`/`BASIC_PASS`; `CANCEL_DIRECT_AUTH_USER`/`CANCEL_DIRECT_AUTH_PASS`, se as duas estiverem definidas, substituem essa credencial no modo direto |
| Ramos `guardar` / `leer` / `reasignar`, plano C | usa | **não usa** (nem o bloco `WFATTR`, protegido por um `IF` de `&SUBWORKID`) |
| Fluxo original | para só com `CANCEL_STOP_ORIGINAL=true` (senão, passo seguinte do mapa) | **sempre para**, qualquer que seja `CANCEL_STOP_ORIGINAL` (não há passo seguinte) |
| `IDs Cancelados`, SendOn da tarefa | sim | **não há** (`sentOn: false`) |
| Habilitação no servidor | `CANCEL_ENABLED` | `CANCEL_ENABLED` **e** `CANCEL_DIRECT_ENABLED` (padrão `false`) **e** uma credencial Basic (`CANCEL_DIRECT_AUTH_*` ou, sem elas, a do `/auth`); senão as três rotas diretas dão `404` (preflight CORS inclusive). `CANCEL_DIRECT_ENABLED=true` sem nenhuma credencial não monta as rotas e registra no startup `[CANCEL] CANCEL_DIRECT_ENABLED=true sin credencial Basic (CANCEL_DIRECT_AUTH_*, START_AUTH_* o LOG_*): cancelación directa deshabilitada` |

**Protocolo.** "Revisar": `POST /cancel/direct/auth` (Basic `BASIC_USER`/`BASIC_PASS`) com `{targetWorkflowIds: ["3101","3102"], requestedBy?}`
e `POST /cancel/direct/preview` com os **mesmos** campos mais `timestamp`, `nonce` e `signature` (mesma lista e mesma ordem, em texto).
"Cancelar": novo `/cancel/direct/auth` e `POST /cancel/direct`. Cada chamada consome um nonce; v1 é recusada, como no `/cancel`.

**Assinatura com escopo (chave derivada).** `/cancel/direct/auth` devolve `{ v: 2, timestamp, nonce, signature }` como o `/auth`, mas assina
com a chave derivada `HMAC-SHA256(SIGNATURE_SECRET, 'cancel-direct')` (`deriveKey` em `middleware/hmac.js`), e `/cancel/direct` e
`/cancel/direct/preview` verificam com essa mesma chave. Então uma assinatura do `/auth` genérico (cuja credencial `START_AUTH_*`/`LOG_*`
fica embutida nos WebReports de firma 650835/702040, legíveis por muitos usuários) **nunca** vale nas rotas diretas, e uma assinatura
direta **nunca** vale em `/start`, `/cancel` nem `/cancel/preview`. O `/auth` genérico não mudou.

**Forma canônica do HMAC.** A de sempre (`v2\n<timestamp>\n<nonce>\n<workflowId>\n<subworkflowId>\n<nodeId>\n<attachId>\n<emails>\n<docName>`)
**mais duas linhas só quando `targetWorkflowIds` vem no corpo** (não `undefined`/`null`): `\n<targetWorkflowIds>\n<targetSubworkflowId>`.
A lista é cada item em texto, na ordem enviada, unido por `,`; um valor que não é lista entra como o texto do valor. Sem
`targetWorkflowIds` a forma é idêntica à anterior (`/start` e `/cancel` da tarefa não mudam). Trocar a ordem, acrescentar ou tirar
um alvo, ou mudar o subflujo invalida a assinatura (`403 Invalid signature.`). Atenção: a string `"1,2"` tem o mesmo texto
canônico de `["1","2"]` (a assinatura bate), mas o serviço só aceita lista e responde `422 INVALID_TARGET`. `requestedBy` **não**
entra no HMAC.

**Corpo e respostas.** `targetWorkflowIds` (lista de WorkIDs numéricos, 1 a `CANCEL_MAX_TARGETS`, sem repetidos), `targetSubworkflowId`
(opcional; só vale com **um** alvo, senão `subworkflowIgnored: true`) e `requestedBy` (opcional).
- `/cancel/direct/preview` → `{ mode: "direct", items, summary, stopOriginal: true, subworkflowIgnored }`; só consulta.
- `/cancel/direct` → `{ mode: "direct", complete, sentOn: false, items, summary, stopOriginal: true, subworkflowIgnored }`. Cada item
  tem `outcome` (`cancelled`/`refused`/`pending`) e `contentStop`. `complete: false` = há `pending` (inclusive `STOP_FAILED`:
  cancelado no Adobe, falta parar o original).
- `422`: `MISSING_TARGET` (lista vazia), `INVALID_TARGET` (não é lista, valor não numérico, subflujo inválido), `TOO_MANY_TARGETS`.
  Nunca devolve `REASSIGN_REQUIRED`, `NOT_AT_CANCEL_STEP` nem `RESULT_*`/`SENDON_FAILED`.

**Decisões da página.**
- A página **não envia `targetSubworkflowId`**: a seleção é por WorkID (cancela e para o processo pai) e, com vários acordos abertos
  no fluxo, o servidor responde `AMBIGUOUS` em vez de cancelar só um e parar o pai. O servidor aceita o subflujo (um alvo), mas o caso
  vai por `POST /admin/cancel-workflow/{id}`.
- **"Reintentar pendientes" reenvia só os WorkIDs ainda pendentes** (novo `/auth` com essa lista). É idempotente (já cancelado →
  `alreadyCancelled`, stop repetido → `already_stopped`). A tela acumula os resultados das tentativas na ordem da seleção.
- `requestedBy`: a constante `USUARIO_SOLICITANTE` do script vem **vazia**; não há tag do OTCS validada que entregue o login. O
  servidor o limpa (uma linha, `[A-Za-z0-9._@-]`, no máximo 64 caracteres) e o grava em `cancel_source` como
  `webreport:direct:<usuário>` (sem ele, `webreport:direct`) e no comentário do Adobe ("Solicitado por ..."). Só auditoria.
- Seleção em `sessionStorage` com a chave `cancelar-sel-directo`; limpa quando o lote conclui.
- O texto "la tarea" não aparece; o final é "Los acuerdos se cancelaron en Adobe Sign y los flujos originales se detuvieron en Content
  Server". Se algum item não foi cancelado (assinado, ambíguo...), o final é um aviso com o motivo de cada um.
- `404` nas rotas diretas → "La cancelación directa no está habilitada en el servidor (CANCEL_DIRECT_ENABLED)"; no
  `/cancel/direct/auth` → "... (CANCEL_DIRECT_ENABLED y credencial Basic)".

**Segurança e auditoria.** O modo direto não tem tarefa que prove quem pode cancelar: a autorização é a **permissão sobre o WebReport no
OTCS** (restringir **este** WebReport a um grupo autorizado, e quem pode ver/editar a fonte) e a credencial Basic do
`/cancel/direct/auth` (`CANCEL_DIRECT_AUTH_*` ou, sem elas, a do `/auth` genérico, `BASIC_USER`/`BASIC_PASS`), que fica no script publicado: quem a ler pode assinar qualquer lista e cancelar. **Risco aceito:** com uma credencial só, quem puder ler a fonte de qualquer WebReport que a embuta pode usar o mesmo Basic para chamar `/admin` e para cancelar ou parar fluxos pelo modo direto. A assinatura tem escopo próprio: a do `/auth` não vale nas rotas diretas, e a direta não vale em `/cancel` nem em `/start`. O HMAC vincula a lista revisada à chamada (não dá
para trocar os alvos entre a assinatura e a rota, nem reaproveitar uma assinatura da tarefa ou do `/start`), mas não identifica a
pessoa. `POST /admin/cancel-workflow/{id}` (credencial `LOG_*`) é um caminho à parte, anterior, e não muda. Não existe `IDs Cancelados` nem SendOn: a auditoria fica só no banco do orquestrador (`cancel_source`, evento
`CANCEL_REQUESTED`) e nos logs `[CANCEL] Directo (...)`; no OTCS o stop aparece no histórico do processo como o usuário de integração.

## Mensagens da página por código

Textos em espanhol, como na página. "Reintentar" diz se o botão faz sentido. Os erros da lista (`MISSING_TARGET`, `INVALID_TARGET`,
`TOO_MANY_TARGETS`) também mostram "Cambiar selección".

| Código (ou status) | Mensagem (resumo) | Reintentar |
|---|---|---|
| `AGREEMENT_NOT_FOUND` | No se encontró un acuerdo de firma; soporte adopta con `POST /admin/adopt/{id}` | sim |
| `AGREEMENT_NOT_FOUND_IN_ADOBE` | El acuerdo ya no existe en Adobe Sign; no hay nada que cancelar | não |
| `AMBIGUOUS` | Más de un acuerdo abierto; no se canceló ninguno. Cancelar por separado: un flujo en "ID Flujo a Cancelar" y el subflujo en "ID Subflujo a Cancelar" | não |
| `AGREEMENT_CLOSED` | El acuerdo más reciente de este flujo ya concluyó | não |
| `ALREADY_SIGNED` | El acuerdo ya fue firmado por todos; no se puede cancelar. Regularizar el flujo | não |
| `ALREADY_REJECTED` | Un firmante rechazó el acuerdo; el flujo original recibirá el rechazo | não |
| `NOT_CANCELABLE` | El estado del acuerdo en Adobe Sign no permite cancelarlo | não |
| `IN_PROGRESS` | Ya hay una cancelación en curso para este acuerdo | sim |
| `BUDGET_EXCEEDED` | No alcanzó el tiempo para este flujo; los ya cancelados no se vuelven a cancelar | sim |
| `UNEXPECTED_ERROR` | Error inesperado; si persiste, avisar a soporte | sim |
| `STOP_FAILED` (item `pending`, `cancelledInAdobe: true`) | Cancelado en Adobe Sign; falta detener el flujo en Content Server. Revisar permisos del usuario de integración | sim (Adobe no se cancela de nuevo) |
| `NOT_AT_CANCEL_STEP` | El flujo no está en el paso "Cancelar Flujo de Firma" (quizá ya se completó) | não |
| `FLOW_NOT_FOUND` | No se encontró el flujo de cancelación en Content Server | não |
| `MISSING_TARGET` / `INVALID_TARGET` / `TOO_MANY_TARGETS` | Seleccionar o corregir "ID Flujo a Cancelar" (solo números; máximo de flujos del servidor) | não (cambiar selección) |
| `ADOBE_UNAVAILABLE` / `OTCS_UNAVAILABLE` / `RECONCILE_IN_PROGRESS` | Adobe Sign, Content o sincronización no disponibles; no se modificó nada | sim |
| `RESULT_FIELD_MISSING` | Error de configuración: falta "IDs Cancelados" en el formulario; no se canceló nada ni se avanzó | sim, tras corregir |
| `RESULT_WRITE_FAILED` | Los flujos se procesaron, pero no se registró la lista de cancelados; no se avanzó la tarea | sim (es seguro) |
| `SENDON_FAILED` | Los acuerdos ya fueron cancelados, pero no se pudo continuar el flujo de cancelación | sim (es seguro) |
| `REASSIGN_REQUIRED` | Reasigna la tarea y repite una vez | sim |
| 404 sin `code` | La cancelación de flujos no está habilitada en el servidor (`CANCEL_ENABLED=false`) | não |
| 404 sin `code` (modo directo) | La cancelación directa no está habilitada en el servidor (`CANCEL_DIRECT_ENABLED` y credencial Basic). **Só aparece se a resposta chegar ao script** (mesma origem). Com o modo direto desligado o servidor responde 404 **sem cabeçalhos CORS** (o preflight também) e, a partir do OTCS, o navegador mostra um erro de rede/CORS: a página exibe "No se pudo conectar con el servidor de firmas." | não |
| contexto misto (alguns de `WORKID`/`SUBWORKID`/`TASKID` resolvidos) | Datos de la tarea inválidos: abra esta página desde la tarea...; nenhuma chamada ao servidor | — |
| falha de rede | No se pudo conectar con el servidor de firmas | sim |
| plano C: `guardar` sem `GUARDADO_OK` | No se pudo guardar la selección (OpenText no confirmó); se muestran los IDs para pegarlos a mano | — |
| plano C: `leer` não bate | El atributo no refleja la selección | — |
| plano C: `leer` não verificável | No se pudo verificar la selección guardada | — |
| `REPORT_ID` placeholder | Datos de la tarea inválidos (guardar) / Datos de reasignación inválidos (reasignar) | — |

## Parada do fluxo original (`CANCEL_STOP_ORIGINAL`)

**Decisão (23/10/2026):** o fluxo original parado é o **processo inteiro** (`WorkID`). Em sub-fluxos de firma de
Contratación e Documental, o `WorkID` é o **pai**: a Contratación/Documental inteira é encerrada, não só a firma. Base: o
ticket 2026060410003715 (`Casos Keralty.docx`) pede "detener completamente un flujo que no se necesite ejecutar" e, depois
do cancelamento no Adobe, "envíe la cancelación del flujo en el content y demos por cerrado los dos flujos"; não fala de
sub-fluxo, e o usuário definiu que, sem especificação, o fluxo fecha. **O fluxo de firma nunca roda sozinho** em produção:
é sempre sub-fluxo, e devem parar **os dois** (pai e firma). No OTCS o sub-fluxo pertence ao mesmo processo do pai
(`wsubwork.subwork_workid` = `WorkID` do pai), e o stop (`PUT /v2/processes/{WorkID}/status`) é sobre esse processo.
**Validado no QA (24/10/2026):** cancelamento 12334448 do pai 12334150 (Flujo documental - Bienestar), sub-fluxo de firma
12337316. Às 02:40:25 o acordo foi para `CANCELLED` no Adobe e o pai ficou "Workflow stopped" (`work_status` -2), sem tarefa
em `current`: o "Aguardar Firma" do sub-fluxo deixou de estar ativa, sem parar o sub-fluxo à parte. `IDs Cancelados` =
`12334150` e o SendOn concluiu o fluxo de cancelamento.

- Com `CANCEL_STOP_ORIGINAL=true` o orquestrador **para** (stop, nunca exclui nem arquiva) o fluxo original no Content, item a
  item, logo depois de o Adobe confirmar o cancelamento. Então o passo "Detener flujos originales" do mapa **não é necessário** (e
  não deve rodar junto, para não parar duas vezes). O texto da prévia diz: "Al confirmar, los flujos se cancelan en Adobe Sign y se
  detienen en Content Server". Cada item do resultado mostra `contentStop`: "Detenido en Content", "Ya estaba detenido" ou
  "No se pudo detener" (`disabled` não mostra nada).
- Com o flag desligado (padrão): só o Adobe é cancelado, e há um **passo extra entre a tarefa e o Fim** que para os WorkIDs de
  `IDs Cancelados`. Texto da prévia: "Los flujos se cancelan solo en Adobe Sign; el flujo original se detiene en el paso siguiente".
- Se o stop falhar, o item fica `pending` (`STOP_FAILED`): nada é gravado nem há SendOn até repetir ("Reintentar pendientes"; o
  Adobe não é cancelado de novo, só o stop é refeito).
- O usuário de integração (AdminKeralty) precisa de permissão para parar processos (o OTCS responde 400 sem ela).

## Configuração por ambiente

Os itens comuns (`SERVER_URL`, usuário de integração, Basic, CORS) estão em
[`../README.md`](../README.md#o-que-muda-em-prod-comum). Específicos desta página (bloco **CONFIGURACION POR AMBIENTE** do script
e linha `WFTASKACTION:REASSIGN`):

| Valor | Onde | Observação |
|---|---|---|
| `REPORT_ID` | script | ID do nó deste WebReport no ambiente; usado pelos ramos `guardar`, `leer` e `reasignar`. Placeholder `REPORT_ID_POR_ASIGNAR`: sem ID numérico, a gravação e a reatribuição não rodam |
| `MAX_FLUJOS` | script | Deve ser igual a `CANCEL_MAX_TARGETS` do servidor (padrão 20) |
| `ATRIBUTOS_FIRMA` | script | `wf_attrid` do sub-fluxo de firma: empleado 4 (tipo 14), documento 7, docId 6 e correo 10 (Email Firmante 1, tipo -1). Iguais em todos os mapas de firma (clones); só mudam se o formulário do mapa mudar |
| `SERVER_URL`, `BASIC_USER`, `BASIC_PASS` | script | por ambiente; `ADOBE-LOGS` / `ADOBE-LOGS-PASS` são placeholders |
| usuário de integração | linha `WFTASKACTION:REASSIGN` do ramo `reasignar` | QA: 11742766 (AdminKeralty); PROD: ID do AdminKeralty de PROD |
| nomes dos atributos | tags `WFATTR` / `SETWFATTR` e constante `ATRIBUTO` | `ID Flujo a Cancelar` / `ID Subflujo a Cancelar` iguais a `CANCEL_FIELD_TARGET_*` do servidor |

Modo direto: não usa `REPORT_ID` nem o usuário de integração da reatribuição, mas exige `CANCEL_DIRECT_ENABLED=true` e uma credencial Basic no servidor; no script, `BASIC_USER`/`BASIC_PASS` (placeholders: devem ser a
credencial que o servidor aceita no modo direto, ou seja, `CANCEL_DIRECT_AUTH_*` se definidas, senão a do `/auth`) e `USUARIO_SOLICITANTE` opcional (ver "Modo direto").

Lado do servidor (ConfigMap): `CANCEL_ENABLED`, `CANCEL_DIRECT_ENABLED` (padrão `false`, modo direto), `CANCEL_DIRECT_AUTH_USER` / `CANCEL_DIRECT_AUTH_PASS` (opcional: credencial própria do modo direto; sem elas, vale a do `/auth`; Secret), `CANCEL_TASK_NAMES`, `CANCEL_FIELD_TARGET_WORKFLOW`,
`CANCEL_FIELD_TARGET_SUBWORKFLOW`, `CANCEL_FIELD_RESULT` (padrão `IDs Cancelados`), `CANCEL_MAX_TARGETS` (padrão 20),
`CANCEL_STOP_ORIGINAL` (padrão `false`), `CANCEL_BATCH_BUDGET_MS` (padrão 15000, prazo único do lote), `CANCEL_SETTLE_TIMEOUT_MS`
(padrão 20000). Ver a tabela no design.

## LiveReport (`Cancelar Flujo de Firma.sql`)

**Divisão:** o LiveReport só traz dados, genérico para qualquer mapa e **sem parâmetros**; filtros, escolha dos atributos por
mapa e regras ficam no WebReport, que pode ser editado no destino (o LiveReport não pode: só é transportado pelo Warehouse).
Assim os IDs que mudam entre instâncias e mapas não ficam no SQL.

- **Versão genérica ainda não executada.** A versão anterior (só mapa Firma, com parâmetros) rodou em 23/10/2026 na
  instância de origem e confirmou tabelas, junções e o status de tarefa ativa.
- Lista **todas** as tarefas "Aguardar Firma" ativas (`subworktask_status = 2`), de qualquer mapa. Em produção a firma é
  sempre sub-fluxo de Contratación ou Documental (`WorkID` = pai, `SubWorkID` = sub-fluxo); `WorkID = SubWorkID` só aparece
  quando o mapa de firma é iniciado sozinho para teste.
- Colunas, na ordem:
  1. `WorkID`: processo pai (é o ID que vai para "ID Flujo a Cancelar" e o que é parado);
  2. `SubWorkID`: subprocesso onde está a tarefa (os atributos ficam nele);
  3. `TituloFlujo`: título do processo pai (`wsubwork` com `subworkid = workid`);
  4. `TituloFirma`: título do sub-fluxo de assinatura;
  5. `Mapa`: nome do nó do mapa do sub-fluxo (`wsubwork.subwork_mapid = wmap.map_mapid`, `wmap.map_mapobjid = dtree.dataid`);
  6. `Fecha`: início do sub-fluxo, texto `AAAA-MM-DD HH24:MI` (a página filtra por data com ele);
  7. `EstadoSubflujo`: `subwork_status` do sub-fluxo de firma (códigos não conferidos; a página trata negativo como
     concluído/parado e o oculta);
  8. `Atributos`: JSON com todos os atributos do sub-fluxo, `[{id, t, n, s, i, login, nombre}]` (`wf_attrid`, tipo,
     entrada, `wf_valstr`, `wf_valint`; para tipo 14, usuário, `login` = `kuaf.name` e `nombre` = nome completo);
  9. `EstadoFlujo`: `wwork.work_status` do processo (`WorkID`). Valores vistos em leituras de PROD (20/10/2026): **2** em
     andamento, **-1** concluído, **-2** parado ("Workflow stopped"), e **1** em poucos casos (não identificado; tratado como
     aberto). Um processo parado mantém `subwork_status` 1 nos sub-fluxos, por isso esta coluna é a que separa os já cancelados.
     Está no fim para não mudar a posição das demais. **VALIDAR NO QA** (tabela `wwork` e os valores).
- O WebReport escolhe, **por nome de mapa**, quais atributos usar (empregado, documento, DocID). Mapa **Firma** no QA
  (`wf_attrid`, tipo): 4 Empleado (14), 5 Firmante 2 (14), 6 DocID (-1), 7 Nombre del Documento (-1), 8 AttachID (-1),
  9 WFID (-1), 10 Email Firmante 1 (-1), 11 Email Firmante 2 (-1), 14 Tipo documental (10). Os demais mapas de assinatura
  (sub-fluxos de Contratación e Documental) ainda não foram levantados.
- `subworktask_status` conferido no QA: **2 = ativa**, **1 = ainda não alcançada**, **-1 = concluída**.
- `wfattrdata.wf_id` = `SubWorkID` (conferido pelo diagnóstico no mapa Firma: 0 fluxos sem atributos).
- Sem checagem de permissão por linha (não há coluna `DataID`): **restringir o WebReport e o LiveReport a um grupo**.
- Dialeto: **PostgreSQL** (`JSON_AGG`/`JSON_BUILD_OBJECT`, 9.4+). Comentários mínimos de propósito: o OTCS rejeita termos
  como `FETCH` mesmo em comentário. Sem limite de linhas no SQL; sem `;` no fim.
- **Diagnóstico** (`Cancelar Flujo de Firma - diagnostico.sql`, sem parâmetros): `tareas_aguardar_firma_activas`,
  `por_mapa` (nome e ID dos mapas com a tarefa ativa: é a lista de mapas a configurar no WebReport) e checagens do mapa
  Firma (`atributos_mapa_firma`, `firma_sin_atributos_en_subworkid`, `firma_docid_no_numerico`,
  `firma_empleado_sin_usuario`). Rodado na origem em 23/10/2026: 1 tarefa, mapa `Firma` (21538127), atributos como acima.
- Consultas de ajuda (com o `SubWorkID` de um fluxo em "Aguardar Firma"):
  `SELECT subworktask_taskid, subworktask_title, subworktask_status FROM wsubworktask WHERE subworktask_subworkid = <SubWorkID>`;
  `SELECT wf_attrid, wf_attrtype, wf_entrynum, wf_valint, wf_valstr FROM wfattrdata WHERE wf_id = <SubWorkID>`.
- **Executado no QA em 23/10/2026:** 10 tarefas, mapas `Firma_Contratación_Inactivo`, `Firma_Contratación_Activo` e
  `Firma_Documental`, todos com os mesmos `wf_attrid` (4 a 28) e DocID numérico; `WorkID` (pai) diferente de `SubWorkID`.
  Nos `Inactivo` o Empleado (4) vem vazio (o usuário, quando há, está no Firmante 2).
- A página lê estas 9 colunas por posição e filtra sozinha; testada só com dados simulados (navegador local, 23/10/2026).
- O LiveReport também roda nos ramos `guardar`, `leer` e `reasignar` (o WebReport sempre executa a fonte); as linhas só são
  emitidas na página.

## Checklist de QA

Roteiro do design (acordo de teste `OUT_FOR_SIGNATURE`).

**Primeiro ponta a ponta no QA (24/10/2026, UTC), com `CANCEL_STOP_ORIGINAL=true`:** fluxo de cancelamento 12334140
(com as permissões de workflow do AdminKeralty no mapa: 697/1023), alvo = fluxo Firma 12336731, acordo
`CBJCHBCAABAA1TKdG7nu4_sJBYflDng6AXpxdk7vzX4n`.
- 02:32:51: a tarefa "Cancelar Flujo de Firma" passa ao AdminKeralty (reatribuição pela página).
- 02:32:58: acordo `CANCELLED` no Adobe (evento `RECALLED`, comentário "Flujo cancelado desde Content Server (workflow de
  cancelación 12334140)"); webhook `AGREEMENT_RECALLED` recebido; fluxo 12336731 suspenso e parado ("Workflow stopped").
- 02:32:58: `IDs Cancelados` = `12336731` (o `formUpdate` do servidor gravou o multivalor), SendOn da tarefa e o fluxo de
  cancelamento concluído ("Fin").

Os itens abaixo seguem como roteiro; os cobertos por esse teste são a gravação/conferência, a reatribuição, o cancelamento
de um acordo `OUT_FOR_SIGNATURE`, o stop do original e o registro em `IDs Cancelados`.

- [ ] Servidor com `CANCEL_ENABLED=true` e a página publicada. Com `CANCEL_ENABLED=false`, o clique em "Revisar" mostra "no está habilitada".
- [ ] Mapa de uma tarefa (Início → "Cancelar Flujo de Firma" → Fim), com o campo `IDs Cancelados` no formulário.
- [ ] Seleção: filtros funcionam; limite de 20 (ou o `CANCEL_MAX_TARGETS`); a seleção sobrevive a uma nova busca.
- [ ] Seleção: um usuário sem permissão sobre um fluxo não o vê (checagem do LiveReport; ver VALIDAR NO QA, item 9).
- [ ] "Revisar N flujos": grava `ID Flujo a Cancelar`, `LEIDO_OK` confere os valores, e **só então** aparece a primeira chamada ao
      servidor (DevTools, aba Network: `guardar` e `leer` antes de `/auth`).
- [ ] Plano C: simular `leer` com valor diferente / `guardar` sem `GUARDADO_OK`: nenhuma chamada ao servidor; "Copiar IDs"; colar no
      formulário, guardar, F5: a página reabre mostrando os IDs.
- [ ] Reabertura com IDs gravados (por exemplo, pendentes de um lote anterior): mostra os IDs, "Revisar flujos" vai direto à prévia
      sem regravar, "Cambiar selección" volta à seleção com esses IDs marcados.
- [ ] "Cambiar selección" **depois da revisão**, com a tarefa já no AdminKeralty: o que acontece com a gravação (esperado: pode
      falhar e cair no plano C com a explicação). Registrar o comportamento real.
- [ ] A revisão transfere a tarefa ao AdminKeralty (`REASSIGN_REQUIRED` → ramo `reasignar` → `REASIGNADO_OK` → repete) e o aviso aparece.
- [ ] Atributo com valor não numérico: o servidor responde `INVALID_TARGET` e a página oferece "Cambiar selección".
- [ ] Prévia: cada grupo aparece com o item certo; firma parcial exige a ciência; firmado fica fora do botão de confirmar.
- [ ] Lote misto (cancelado, firmado, não encontrado): só os cancelados vão para `IDs Cancelados`; SendOn; o passo seguinte
      (se houver) para só os WorkIDs de `IDs Cancelados`.
- [ ] Acordo `OUT_FOR_SIGNATURE`: acordo `CANCELLED` no Adobe; fluxo original **sem** `Rechazado` indevido (o
      `AGREEMENT_RECALLED` não gera disposição).
- [ ] `CANCEL_STOP_ORIGINAL=true`: a prévia mostra "se detienen en Content Server"; após cancelar, o processo original aparece
      parado no Content e o item mostra "Detenido en Content"; o passo "Detener flujos originales" não é usado.
- [ ] Permissão do AdminKeralty para parar processos: com a permissão removida, o item vira `STOP_FAILED` ("falta detener"), sem
      gravar `IDs Cancelados` nem SendOn; restaurada, "Reintentar pendientes" para o processo sem cancelar o Adobe de novo.
- [ ] Repetição com o processo já parado: "Ya estaba detenido". Flag desligado: a prévia diz "se detiene en el paso siguiente".
- [ ] Repetir (idempotência): `alreadyCancelled` ou `NOT_AT_CANCEL_STEP`, conforme o passo.
- [ ] Fluxo ambíguo: não cancela nenhum; a página orienta cancelar sozinho, com o subflujo.
- [ ] Fluxo já assinado: "ya fue firmado", nada cancelado.
- [ ] Lote com `CANCEL_BATCH_BUDGET_MS` baixo: itens `BUDGET_EXCEEDED` (pendientes), sem gravar; "Reintentar pendientes" conclui.
- [ ] `RESULT_FIELD_MISSING` (campo removido no QA): erro de configuração, nada cancelado; a prévia traz `resultFieldMissing`.
- [ ] `RESULT_WRITE_FAILED` e `SENDON_FAILED` simulados: "Reintentar" conclui sem cancelar de novo.
- [ ] Ramo `reasignar`: abrir `…?func=ll&objAction=RunReport&objId=<REPORT_ID>&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar` e conferir.
- [ ] Sem `accion`, a URL do WebReport só mostra a página (sem `GUARDADO_OK`, `LEIDO_OK` nem `REASIGNADO_OK`, sem gravação).

**Modo direto** (`CANCEL_ENABLED=true` e `CANCEL_DIRECT_ENABLED=true`; ainda não testado no OTCS):
- [ ] Abrir o WebReport **sozinho** (sem workflow): conferir como o OTCS renderiza `&WORKID`/`&SUBWORKID`/`&TASKID` (vazio ou literal), que a
      introdução mostra o texto do modo direto, que o `IF` de `&SUBWORKID` evita o bloco `WFATTR` sem erro, e que nenhuma chamada
      `accion=guardar|leer|reasignar` aparece (DevTools, Network). Abrir pela tarefa continua no modo tarefa.
- [ ] `CANCEL_DIRECT_ENABLED=false` (ou sem nenhuma credencial Basic, que também registra o erro no startup): `OPTIONS` e `POST` em
      `/cancel/direct/auth`, `/cancel/direct` e `/cancel/direct/preview` dão 404 **sem cabeçalhos CORS**. No navegador, a partir do OTCS, "Revisar"
      mostra o erro de rede "No se pudo conectar con el servidor de firmas." (a mensagem "no está habilitada" só aparece em chamadas de mesma origem).
- [ ] **URL sem `taskid`** (ou só com `workid`/`subworkid`): a página mostra "Datos de la tarea inválidos...", sem botões, e o Network não mostra
      nenhuma chamada a `/auth`, `/cancel/direct/auth` nem `/cancel*`. Idem com um só dos três IDs preenchido.
- [ ] Credenciais: `START_AUTH_*`/`LOG_*` em `/cancel/direct/auth` → 401; assinatura do `/auth` genérico em `/cancel/direct*` → 403 `Invalid signature`;
      assinatura de `/cancel/direct/auth` em `/start` ou `/cancel` → 403.
- [ ] Revisar: `/cancel/direct/auth` e `/cancel/direct/preview` levam o mesmo `targetWorkflowIds` (mesma ordem); nada é cancelado nem parado.
- [ ] Confirmar: acordo `CANCELLED` no Adobe **e** processo original parado, mesmo com `CANCEL_STOP_ORIGINAL=false`; itens com
      "Detenido en Content"; nenhum SendOn nem `IDs Cancelados`; log `[CANCEL] Directo (webreport:direct)`; `cancel_source` no banco.
- [ ] Adulterar a lista entre o `/cancel/direct/auth` e a rota (curl ou DevTools): `403 Invalid signature.`; repetir o mesmo corpo: `403` (nonce).
- [ ] Lote misto (cancelado, assinado, não encontrado): os recusados não são parados; o final avisa que nem todos foram cancelados.
- [ ] `STOP_FAILED` (permissão removida): "Reintentar pendientes" reenvia só o pendente e não cancela o Adobe de novo.
- [ ] Permissões: usuário sem acesso ao WebReport não o abre; o LiveReport só mostra o que ele pode ver (VALIDAR NO QA, item 9).
- [ ] Opcional: descobrir uma tag do OTCS que entregue o login e preencher `USUARIO_SOLICITANTE` (hoje vazio).

## VALIDAR NO QA

1. Formato de exibição do multivalor em `WFATTR ...:DISPLAY` (a página só extrai os números, para mostrar e comparar).
2. **Gravação: `WFACTION:SETATTR`, não `SETWFATTR`.** Pela documentação do WebReports, o `SETWFATTR` só grava num WebReport
   com destino Workflow ou dentro de um passo WebReports (é o caso dos Set Attributes do QA: 650734, 702053, 11947900). Esta
   página chama o WebReport por URL (standalone): no QA (23/10, workflow 12336820, tarefa 2) `accion=guardar&ids=11948126`
   respondia `11948126 GUARDADO_OK` (a tag só ecoava o valor) e `accion=leer`, `LEIDO_OK ?`. Para WebReport standalone a
   documentação indica `WFACTION:SETATTR`, com o **SubWorkID** na tag principal e as permissões do usuário sobre o workflow:
   ```
   [LL_REPTAG_&SUBWORKID WFACTION:REMOVEATTR:"ID Flujo a Cancelar":ALL /]
   [LL_REPTAG_&SUBWORKID WFACTION:SETATTR:MV:"ID Flujo a Cancelar":1:[LL_REPTAG_&IDS /] /]
   ```
   O `REMOVEATTR ... ALL` limpa a seleção anterior (o primeiro valor é esvaziado, os demais saem); o `SETATTR:MV:...:1` grava os
   IDs separados por vírgula no primeiro valor. **Validado no QA (23/10):** grava e o ramo `leer` confere (nome com espaços entre
   aspas funciona). Ainda não testados: vários IDs (vírgula no valor) e a troca de seleção com valores anteriores.
3. Segurança do ramo `guardar`: `ids` vem da URL e entra como texto dentro da tag `WFACTION` (um `:` ou `/]` mudaria a tag). A
   página valida o formato, o WebReport não; o servidor rejeita não numéricos (`INVALID_TARGET`). O GET com a sessão do usuário
   é alcançável por link: restringir o WebReport a um grupo.
4. ~~`LL_WEBREPORT_STARTROW`/`ENDROW` dentro dos três IF aninhados.~~ Validado no QA (23/10): dentro dos IF a listagem não
   funcionava. Os marcadores de linha não podem ficar dentro de um IF aberto: os três IF são fechados antes do `STARTROW`,
   reabertos dentro da linha em volta do `<tr>` e reabertos de novo depois do `ENDROW`.
5. Saída das colunas do LiveReport no WebReport: o JSON de `Atributos` (coluna 8) chega íntegro dentro do textarea e
   `Fecha` (coluna 6) no formato `AAAA-MM-DD HH24:MI`. `EstadoFlujo` (coluna 9) chega como `-2` num processo parado pelo
   cancelamento e como `2` num em andamento (o fluxo parado some da lista por padrão).
6. `&WORKID`, `&SUBWORKID` e `&TASKID` disponíveis na tarefa quando o WebReport abre.
7. Formulário aberto pode sobrescrever o atributo ao enviar a tarefa; e se o formulário permite guardar sem enviar (plano C).
8. Forma do array que o servidor envia a `IDs Cancelados` (`updateTaskForm`), e a leitura desse atributo multivalor pelo
   servidor: não validadas no OTCS.
9. Permissões: o LiveReport lista todos os fluxos em "Aguardar Firma", sem checagem por linha; restringir o WebReport e o
   LiveReport ao grupo que pode cancelar.
10. `REPORT_ID_POR_ASIGNAR` bloqueia a gravação e a reatribuição até ser trocado.
11. SQL inteiro: tabelas e colunas, tabela de atributos, código de tarefa ativa e IDs de atributos (o dialeto é PostgreSQL).
12. Gravar o atributo depois que a tarefa foi transferida ao AdminKeralty ("Cambiar selección" pós-revisão): permissão do usuário
    humano sobre a tarefa; ver o risco acima.
13. Valores de status do processo usados pelo servidor para reconhecer "já parado" (`CANCEL_STOP_ORIGINAL`) e a permissão do
    AdminKeralty para parar processos.

## Pendiente

- **Mapa publicado no QA (23/10):** mapa "firma cancelamento" (versão 12334429), WebReport 12335607 ("Firma Cancelamento"),
  atributos `ID Flujo a Cancelar` (texto, multivalor até 20), `ID Subflujo a Cancelar` e `IDs Cancelados`. Falta, com
  `CANCEL_STOP_ORIGINAL=false`, o passo que para só os WorkIDs de `IDs Cancelados`.
- **Permissão do usuário de integração no workflow (obrigatória).** No QA (workflow 12334430), o AdminKeralty tinha
  `PERMISSIONS`/`MANAGER_PERMISSIONS` = 0 e o `step_list.current` vinha vazio: o servidor responde `NOT_AT_CANCEL_STEP`
  ("quizá ya se completó") com a tarefa ativa, sem reatribuir nem concluir nada (a auditoria só mostra o início). Nos fluxos
  de Contratación (ex. 11967303, iniciado pelo mesmo usuário) ele tem 679/1023 e vê a tarefa. O mapa de cancelamento precisa
  dar ao AdminKeralty (ou a um grupo dele) as mesmas permissões de workflow do mapa de Contratación.
- **LiveReport sem placeholders, mas ainda não executado** no OTCS; atributos conferidos só para o mapa Firma.
- **Aviso de firma parcial** mostra a quantidade e a data, mas o servidor não bloqueia o cancelamento: a página só exige
  ciência. Decisão pendente (ver o design, "Em aberto", item 4).
- **Fluxo ambíguo** não se resolve na página: o servidor só aceita subflujo com um fluxo, e a página não grava
  `ID Subflujo a Cancelar`. Ela orienta cancelar esse fluxo sozinho, com o subflujo.
- **Acordos do orquestrador antigo** (`no_encontrado`): o cancelamento só acha o acordo de um fluxo pelo SQLite
  (`listByWorkflow`), e os acordos do serviço antigo não têm o `externalId` que permite a adoção automática. A dica (adoção
  via `POST /admin/adopt/:id`, rota administrativa) é só texto; a página não adota.
  - **Migração dos dados em PROD (pendente):** importar para o SQLite o mapa `agreements.json` do orquestrador antigo, para
    que os fluxos abertos antes do deploy possam ser cancelados. O código já existe (`server/infra/legacyImport.js`, roda
    no start); falta executar e conferir em PROD, seguindo o passo "3. Acordos em andamento no orquestrador antigo" de
    [`deploy/openshift/README.md`](../../deploy/openshift/README.md).
  - No código de referência o arquivo fica em `/tmp/agreements.json`, que se perde quando o pod antigo é recriado.
    Confirmar antes se ele existe e quantos acordos tem. O que já tiver sumido só volta por adoção, um a um.
- **Reabrir a página depois da reatribuição:** a tarefa sai do usuário humano. Se a página for recarregada antes de o
  cancelamento concluir, a leitura de `WFATTR` e a resposta `NOT_AT_CANCEL_STEP` dependem de permissões do OTCS não validadas.
- **Plano C** (copiar e colar) depende do formulário aberto; não foi testado.
- **Não validado:** todo o comportamento das tags OTCS (`WFATTR`, `SETWFATTR`, `&ACCION`, a forma entre aspas do
  `WFTASKACTION:REASSIGN`, `URLPREFIXFULL`), herdado da página do fluxo puro, só se confirma no QA. A página não foi
  executada contra o servidor real: só a sintaxe do script e uma simulação com DOM e `fetch` falsos.
- **Exclusão do fluxo original** não está implementada nem decidida (ver o design, "Em aberto", item 5).
- **Orçamento de tempo x timeout da rota:** o servidor usa um prazo único de 15 s por pedido (a espera pela reconciliação
  de cada item também é limitada ao tempo restante); o pior caso normal fica abaixo dos ~30 s da rota. Falta medir no QA
  (ver o design, "Em aberto", item 16).
- `PUT /agreements/{id}/state` do Adobe, `notifyOthers` e o evento `AGREEMENT_RECALLED` seguem pendentes de validação no QA
  (ver o design, "Em aberto", item 13).
