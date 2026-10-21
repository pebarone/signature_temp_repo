# QA no Render

O ambiente de QA do orquestrador roda no Render, com **storage efêmero e sem PVC**. Produção roda no OpenShift
(ver `deploy/openshift/README.md`). Este documento descreve o que o storage efêmero implica para os testes e como mitigar.

## Storage efêmero

- O código só detecta o Render pela variável `RENDER=true`. Confirme que ela está definida no serviço.
- Sem `DATA_DIR`, com `RENDER=true` (ou `NODE_ENV=production`), o estado vai para `/tmp/signature-orchestrator`
  (`TMP_DATA_DIR`). Ver `computeConfig` em `server/config/index.js`.
- Esse diretório guarda `state/orchestrator.db`, `state/tokens.json`, `logs/` e `inprocess/`.
- Na inicialização, o log traz um aviso `[STORAGE] Storage efímero (...)`. É o esperado no QA.
- Não defina `REQUIRE_PERSISTENT_STORAGE=true` no Render. Com a flag, o processo encerra na inicialização, porque o storage é efêmero.

## O que se perde

A cada deploy, restart, troca de instância ou hibernação do serviço, apagam-se:

- o SQLite: mapa acordo->workflow, estado dos acordos, fila de retries e histórico de eventos;
- `tokens.json`: os tokens OAuth do Adobe Sign;
- os logs.

## Mitigações

| Mitigação | Como | Efeito e limite |
|---|---|---|
| `ADOBE_REFRESH_TOKEN` no ambiente do Render | Definir a variável com o refresh token obtido na autorização | Após um restart, o orquestrador usa esse token sem precisar de `/admin/login`. Só é usado quando não há refresh token salvo. Se uma nova autorização gerar um refresh token novo, atualize a variável |
| Keepalive | `RENDER=true` com `PUBLIC_URL` definido. `KEEPALIVE_INTERVAL_MS` (padrão 600000, ou seja, 10 min) faz um self-ping em `/health` | Reduz a hibernação por inatividade. Não protege contra deploy nem restart |
| Não usar `REQUIRE_PERSISTENT_STORAGE=true` | Manter a flag ausente ou `false` | Com a flag, o processo recusa subir no storage efêmero |

Variáveis sensíveis (`CLIENT_SECRET`, `LOG_PASS`, `OTCS_PASS`, `ADOBE_REFRESH_TOKEN` e as demais credenciais) ficam só
no painel de Environment do Render. Nunca no repositório.

## Consequências para os testes

- Acordos criados antes de um restart deixam de ser conhecidos no SQLite. Com `ADOPT_UNKNOWN_AGREEMENTS=true`
  (padrão), um novo webhook tenta reconstruir o registro pelo `externalId` do Adobe e reaplica o evento em background.
  O poller não enumera acordos desconhecidos; `POST /admin/reconcile/:id` responde 404 até a adoção.
- Sem novo webhook, use `POST /admin/adopt/:id` (Basic Auth). Para acordos anteriores ao `externalId`, informe
  `{ workflowId, subworkflowId?, nodeId, attachId, fileName? }`. Evite refazer o envio antes de verificar se o acordo existe.
- Evite deploy ou restart no meio de um ciclo de assinatura: a adoção não restaura histórico nem tentativas antigos.
  A adoção automática depende de consultar o Adobe após o webhook; falha nessa consulta ou restart antes de concluir
  a adoção exige outro webhook ou adoção manual (a notificação desconhecida ainda não está persistida).
- Antes de começar um ciclo, confirme nos logs do Render que não houve um novo start (`Server started successfully`)
  entre o envio e o momento em que você espera o retorno.

## Checklist antes de testar

- `/health` responde 200 na URL de `PUBLIC_URL`.
- `PUBLIC_URL` é a URL do serviço no Render, e o webhook da conta Adobe de QA aponta para `<PUBLIC_URL>/webhook`.
- A autorização Adobe está válida: `ADOBE_REFRESH_TOKEN` definido no Render ou `/admin/login` refeito após o último restart.
  Sem uma dessas duas condições, a reautorização é necessária após cada restart.

## QA x PROD

| Item | QA (Render) | PROD (OpenShift) |
|---|---|---|
| Plataforma | Render (`RENDER=true`) | OpenShift (`KUBERNETES_SERVICE_HOST`) |
| Storage | efêmero: `/tmp/signature-orchestrator` | PVC RWO montado em `/data` (`DATA_DIR=/data`) |
| `REQUIRE_PERSISTENT_STORAGE` | ausente ou `false` | `true` |
| Restart ou deploy | apaga SQLite, tokens e logs | preserva o volume |
| Adobe API | definida por `ADOBE_API_BASE` no Render (região do QA). Sem a variável, o código usa EU1 | `https://api.na4.adobesign.com` |
| Adobe OAuth | definido por `ADOBE_AUTH_BASE` no Render. Sem a variável, o código usa EU1 | `https://secure.na4.adobesign.com` |
| OTCS | `https://otcs.g115-test.opentext.cloud/cs/cs/api` | `https://otcs.g115.opentext.cloud/cs/cs/api` |
| `PUBLIC_URL` | URL do serviço no Render | host da Route no OpenShift |
| Keepalive | ativo (`RENDER=true`) | não se aplica |
| Webhook no Adobe | `<PUBLIC_URL>/webhook` do serviço de QA | `<PUBLIC_URL>/webhook` da produção |

A região do Adobe do QA não está fixada no repositório. Confirme o valor de `ADOBE_API_BASE` e `ADOBE_AUTH_BASE` no
Render antes de testar, porque o padrão do código é EU1.
