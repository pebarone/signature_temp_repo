# WebReport "Requisicion de Firma" (fluxo puro)

Página: [`Requisicion de Firma.html`](Requisicion%20de%20Firma.html) (antes `template.html`, na raiz do repositório).
Índice, protocolo v2 (`/auth` + `/start`), regra de reatribuição, tabela de respostas do `/start`, rollout e checklist comum:
[`../README.md`](../README.md).

| | QA | PROD |
|---|---|---|
| Nó do WebReport (`REPORT_ID`) | 650835 | a localizar (equivalente do fluxo puro) |
| Usuário de integração (linha `WFTASKACTION:REASSIGN`) | 11742766 (AdminKeralty) | ID do AdminKeralty de PROD |

No fluxo puro `WORKID = SUBWORKID`, por isso as leituras `&SUBWORKID WFATTR:"..."` (DocID, AttachID, Nombre del Documento,
Email Firmante 1/2) funcionam como estão.

## Visual e dados

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

## O que mudar por ambiente (PROD)

Dois lugares: o bloco **CONFIGURACAO POR AMBIENTE** no topo do script e a linha `WFTASKACTION:REASSIGN` do ramo `reasignar`.
Os itens comuns (`SERVER_URL`, usuário de integração, Basic, CORS) estão em
[`../README.md`](../README.md#o-que-muda-em-prod-comum). Específicos desta página:

1. `REPORT_ID`: ID do próprio WebReport no ambiente (QA `650835`; PROD a definir ao publicar).
2. Link do documento: nada a trocar, a página usa `[LL_REPTAG_URLPREFIXFULL /]` (base do OTCS do próprio ambiente).
3. `RETURN_URL` (botão "Volver a SuccessFactors") aponta para o SuccessFactors de preview; confirmar o de PROD.

## Checklist de QA (650835)

- [ ] Repetir no fluxo puro (650835) o teste de envio do checklist de Contratación (ver
      [`../firma-contratacion/README.md`](../firma-contratacion/README.md)): acordo criado, recarga devolve o mesmo acordo,
      tarefa reatribuída ao usuário de integração.
- [ ] Ramo reasignar: abrir `…?func=ll&objAction=RunReport&objId=650835&workid=<W>&subworkid=<S>&taskid=<T>&accion=reasignar`
      logado com um usuário que tenha a tarefa. A resposta traz `REASIGNADO_OK` e a tarefa passa ao usuário da linha
      `WFTASKACTION:REASSIGN`. Isso prova que `&ACCION`, `&WORKID`, `&SUBWORKID` e `&TASKID` resolvem no ramo `reasignar`.
- [ ] Forma entre aspas: `[LL_REPTAG_{'[LL_REPTAG_&WORKID /]',...} ...]` resolve para os três IDs (não o texto
      literal das tags). Confirmar no OTCS que a tarefa foi para o ID da linha `WFTASKACTION:REASSIGN`.
- [ ] Confirmação: com uma cópia do WebReport apontando a linha `WFTASKACTION:REASSIGN` para um usuário que
      não é o de integração, a página mostra "No fue posible asignar la tarea" e **não** mostra "Listo".
- [ ] `REPORT_ID` do bloco de configuração é o ID do WebReport publicado, e `[LL_REPTAG_URLPREFIXFULL /]` devolve a base do CGI, sem
      barra no final (ex.: `https://host/cs/cs`). O link "Ver documento" abre o documento.
- [ ] Reabrir: fechar a página depois do `/start` com `assigned: false` e antes da reatribuição; ao reabrir,
      a página responde `existing: true`, reatribui, confirma e envia.
- [ ] Nome de documento com apóstrofo (ex.: `Ana's`) aparece certo e o envio funciona. Nome com
      `<img src=x onerror=...>` aparece como texto e não cria elemento.
- [ ] Sem `REASIGNADO_OK` na página normal (abrir a URL do WebReport sem `accion`). Idem `DEVUELTO_OK`.
- [ ] Ramo devolver: com uma tarefa do sub-fluxo já reatribuída ao usuário de integração, abrir
      `…&accion=devolver` logado com o usuário que a tinha. A resposta traz `DEVUELTO_OK` e a tarefa volta à caixa dele.
      **Não validado:** que `[LL_REPTAG_ACTUALUSERID /]` resolve para o ID de quem abriu a página (mesmo com RunAs) e que ele tem permissão para reatribuir
      uma tarefa que já não é dele (ver [`../README.md`](../README.md#ramo-acciondevolver-só-firma-flujo-puro)).
- [ ] Ramo devolver, caso negativo: rodar `accion=devolver` sobre uma tarefa que o usuário **não** pode reatribuir (de outro usuário,
      sem permissão) e conferir se `DEVUELTO_OK` aparece mesmo assim. O ramo imprime a marca depois do `WFTASKACTION` sem checar o
      resultado; se ela aparecer, o ramo precisa de uma pós-condição (ler o responsável da tarefa) antes de imprimi-la. Enquanto isso
      a página só diz que "se intentó devolver" e mostra os IDs.
- [ ] Devolução pela página (sub-fluxo): forçar o segundo `/start` a falhar depois da reatribuição (ex.: apagar o PDF do `DocID`
      entre as duas chamadas ou derrubar o servidor). Esperado: o erro original mais "Se intentó devolver la tarea a su bandeja. Si no aparece, contacte al
      administrador (flujo X, subflujo Y, tarea Z)." e a tarefa de volta ao usuário (conferir na caixa dele: a nota é cautelosa
      de propósito); com o ramo devolver quebrado, a nota "Es posible que la tarea haya quedado asignada al usuario de integración".
      Derrubar a rede **uma única vez** no segundo `/start` não devolve a tarefa: a página repete e mostra o sucesso (`existing`, ou o acordo recém-criado). Com `START_IN_PROGRESS` ou com acordo
      existente a tarefa **não** é devolvida.
- [ ] `PREVIOUS_CYCLE_OPEN`: com o acordo de um envio anterior ainda aberto e a tarefa de envio de novo ativa, a página mostra a
      mensagem do servidor com o ID, sem reatribuir (a tarefa não sai do usuário).

Os itens do checklist comum (NOT_PDF, acordo final, DUPLICATE_OPEN, CORS, logs) também valem aqui: ver
[`../README.md`](../README.md#checklist-comum-de-qa-servidor-e-protocolo).
