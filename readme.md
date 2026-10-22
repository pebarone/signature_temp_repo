# 🔐 Adobe Sign + OpenText xECM Integration
A RESTful API built for orchestrating electronic document signature workflows via Adobe Sign, with full integration to OpenText Content Server (OTCS).  
Exposes endpoints to trigger document signing, monitor status via webhooks, and automate document storage — with full support for OAuth, multiple recipients, and workflow transitions.

## 📌 Purpose

This project sends documents from OTCS to Adobe Sign, retrieves the signed PDF and adds it as a new version of the original Content Server node. The attachment folder is a fallback when that node no longer exists.

---

## 🧱 Architecture

- **Frontend (HTML + JS)**  
  Embedded page within OTCS via WebReport, used as the execution trigger. (A webreport is virtually an HTML page ran inside the main application, with the difference that is supports internal tags and placeholders that are replaced with actual data. If you try and check the HTML, be aware that you'll find these odd non-html stuff.)

- **Backend (Node.js + Express)**  
  Server responsible for:
  - OAuth2 authentication with Adobe Sign (via refresh token)
  - Document download via OTCS API (authenticated via OTDS)
  - Sending documents for signature
  - Asynchronous monitoring via Webhook
  - Automatic upload of the signed PDF to OTCS
  - Secure access with HMAC validation + Basic Auth headers
---

## ⚙️ Features

- 🔁 Continuous integration with Adobe Sign using refresh token
- 📅 Secure download of the original PDF via OTCS API
- ✍️ Supports multiple signers (via Adobe Sign)
- 📡 Webhook to monitor signature status
- 📄 Signed PDF as a new version of the original OTCS node (attachment folder fallback if the node was deleted)
- 🗒️ Detailed logging (daily `audit-YYYY-MM-DD.log` / `error-YYYY-MM-DD.log`, 15-day retention)
- 🧼 Optional purge of temporary files
- ⛔ Duplicate check: prevents resending the same document to the same recipients within 15 minutes
- 🔒 `/start` authenticated by an HMAC (v2) bound to the request fields, with timestamp and a single-use nonce (anti-replay)
- 🔐 `/auth` endpoint protected with Basic Auth (own credential `START_AUTH_*`) to restrict who can obtain signatures
- ✅ `/start` is validated against the OTCS workflow (the Content Server is the source of truth, not the browser)
- 🌐 CORS restricted to `/auth`, `/start` and (when enabled) `/cancel`, only for the OTCS origin
- 🛑 Flow cancellation (ticket 2026060410003715): a cancellation workflow calls `POST /cancel` (same HMAC v2 + nonce model, OFF by default) and the agreement of the flow to cancel is cancelled on Adobe; operator endpoints `POST /admin/cancel/:agreementId` and `POST /admin/cancel-workflow/:workflowId`
---

## 🚀 How to Run

### 1. Clone the repository

```bash
git clone https://github.com/Activos-Digitales-xECM-LATAM/adobe-api.git
cd project-name
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `.env`

Create a `.env` file in the root folder (or set the variables in the platform). Only the first block is required:

```env
# Adobe Sign (required)
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
PUBLIC_URL=https://your-endpoint.example (public base URL: OAuth redirect, webhook and keepalive; ngrok/any tunnel works locally)
# Optional: seed the refresh token instead of using /admin/login
ADOBE_REFRESH_TOKEN=
# Adobe region (default EU1; production uses NA4)
ADOBE_API_BASE=https://api.eu1.adobesign.com
ADOBE_AUTH_BASE=https://secure.eu1.adobesign.com

# OpenText (required)
OTCS_BASE=https://your-content-server/<api-base>   # the code appends /v1/... and /v2/...
OTCS_USER=otds.username
OTCS_PASS=otds.password
SIGN_TASK_NAMES=Aguardar Firma                     # task that receives the final disposition, found BY NAME (comma list; "starts with")
START_TASK_NAMES=Enviar solicitud de firma         # task the integration sends on after creating the agreement (comma list)
# SIGN_TASK_ID=3                                   # OBSOLETE: no longer addresses the disposition (the task is resolved by name)

# Security (required)
SIGNATURE_SECRET=hmac_secret_shared_with_the_webreport
LOG_USER=basic_auth_user                           # Basic Auth for /logs and /admin/* (and for /auth if START_AUTH_* is not set)
LOG_PASS=basic_auth_password
START_AUTH_USER=                                   # optional own Basic Auth for POST /auth (the credential embedded in the WebReport);
START_AUTH_PASS=                                   #   both or none; none => LOG_USER/LOG_PASS
CORS_ORIGINS=                                      # origins allowed on /auth and /start (comma list; "*" only if set). Default: the origin of OTCS_BASE

# POST /start validation against the OTCS workflow (see "/auth and /start")
START_VERIFY_WORKFLOW=true            # false => trusts the (HMAC-bound) payload, as before
START_FIELD_DOCID=DocID               # labels of the start task form attributes (the OTCS values are the source of truth)
START_FIELD_ATTACHID=AttachID
START_FIELD_DOCNAME=Nombre del Documento
START_FIELD_EMAILS=Email Firmante 1,Email Firmante 2
# WebReport migration window ONLY (both OFF by default; each use logs a warn). Legacy always validates against the OTCS
START_LEGACY_SIGNATURE=false          # true => accepts GET /auth and the v1 signature (timestamp only) on POST /start
START_LEGACY_GET_ENABLED=false        # true => accepts the old GET /start?userEmail1=... contract (no HMAC)

# Disposition names in the OTCS workflow (custom_action)
DISPOSITION_SIGNED=Firmado
DISPOSITION_REJECTED=Rechazado
DISPOSITION_EXPIRED=Rechazado         # the maps only have Firmado/Rechazado; Rechazado ends the flow. Empty => needs_attention
DISPOSITION_RECALLED=Rechazado        # empty => needs_attention
DISPOSITION_CONVERSION_FAILED=Rechazado  # empty => needs_attention

# Resilience (defaults shown; see docs/REGLAS_DEL_FLUJO.md)
ATTENTION_RETRY_HOURS=6               # needs_attention for "retries exhausted" reopens by itself after N hours (0 = never)
ADOPT_UNKNOWN_AGREEMENTS=true         # webhook of an agreement not in SQLite: adopt it if its Adobe externalId is ours
WEBHOOK_CLIENT_IDS=                   # extra accepted X-AdobeSign-ClientId values (comma list), besides CLIENT_ID
# Workflow attributes with Adobe data (best effort, OFF: the formUpdate call is not validated in QA yet)
WF_ATTRIBUTES_ENABLED=false
WF_ATTR_AGREEMENT_ID=Adobe ID Acuerdo           # attribute labels in the workflow map; empty disables that attribute
WF_ATTR_STATUS=Adobe Estado
WF_ATTR_LAST_EVENT=Adobe Último Evento
WF_ATTR_UPDATED_AT=Adobe Fecha Actualización
WF_ATTR_INTEGRATION_STATE=Estado Integración Firma

# Flow cancellation (see "Flow cancellation"). The names below are PROVISIONAL: the cancellation workflow map does not exist yet
CANCEL_ENABLED=false                  # true => POST /cancel (WebReport of the cancellation workflow) exists; false => 404. /admin/cancel* do not depend on it
CANCEL_TASK_NAMES=Cancelar Flujo de Firma         # task of the cancellation workflow that runs the WebReport (prefix match, comma list)
CANCEL_FIELD_TARGET_WORKFLOW=ID Flujo a Cancelar  # label of the task form attribute with the ID of the flow to cancel (mandatory, numeric)
CANCEL_FIELD_TARGET_SUBWORKFLOW=ID Subflujo a Cancelar  # label of the optional attribute with its sub-process (numeric)
CANCEL_NOTIFY_SIGNERS=false           # true => Adobe notifies the signers of the cancellation (notifyOthers)

# Storage (see below)
DATA_DIR=                             # explicit data directory (OpenShift: the PVC mount, e.g. /data)
REQUIRE_PERSISTENT_STORAGE=false      # true => refuse to start with ephemeral storage

# Reconciliation / retries / logs (defaults shown)
POLL_ENABLED=true
POLL_INTERVAL_MS=600000               # 10 min
POLL_INITIAL_DELAY_MS=30000
POLL_MAX_PER_TICK=50
POLL_MAX_AGE_DAYS=90
RETRY_BASE_MS=60000                   # exponential backoff: 1 min ... 1 h
RETRY_MAX_MS=3600000
RETRY_MAX_ATTEMPTS=10                 # attempts before needs_attention (0 = unlimited); OTCS 4xx also retry (only data errors go there at once)
ADOBE_DOWNLOAD_ATTEMPTS=8             # retries of 403 on combinedDocument right after signing
LOG_RETENTION_DAYS=15                 # 0 disables the purge
OTCS_TIMEOUT_MS=60000
ADOBE_TIMEOUT_MS=60000                # timeout of every Adobe call (REST and OAuth token refresh/exchange)
WEBHOOK_REQUIRE_CLIENT_ID=false       # true => POST /webhook without X-AdobeSign-ClientId in {CLIENT_ID} + WEBHOOK_CLIENT_IDS gets 401
KEEPALIVE_INTERVAL_MS=600000          # self-ping of /health, only on Render (RENDER=true) with PUBLIC_URL (0 disables)
PORT=3000
```

#### Where the state lives

`state/orchestrator.db` (SQLite: agreement -> workflow map, state, event history), `state/tokens.json` and `logs/`
live under one data directory, chosen in this order:

1. `DATA_DIR` when set (OpenShift: mount a PVC and point `DATA_DIR` to it).
2. Render (`RENDER=true`) or `NODE_ENV=production` without `DATA_DIR`: `/tmp/signature-orchestrator` (**ephemeral**, accepted in QA).
3. Otherwise `./data` in the project root (git-ignored).

Kubernetes/OpenShift (`KUBERNETES_SERVICE_HOST`) without `DATA_DIR` logs an error at startup;
with `REQUIRE_PERSISTENT_STORAGE=true` the process exits instead. A PVC is RWO, so run **one replica** with the
`Recreate` strategy (example in `deploy/openshift/`). An old `agreements.json` found in a previous location is
imported into SQLite on the first start and renamed to `.migrated`.

- OpenShift: requisitos de storage (volume de bloco RWO, uma réplica, classes a evitar) em [`deploy/openshift/README.md`](deploy/openshift/README.md).
- QA no Render (storage efêmero e mitigações) em [`docs/QA_RENDER.md`](docs/QA_RENDER.md).

### 4. Start the server

```bash
npm start      # node server/index.js
npm test       # node --test (fakes for Adobe/OTCS, in-memory SQLite)
```

`better-sqlite3` is a native addon: `npm install` downloads a prebuilt binary when available, otherwise it needs
python3, make and g++ to compile.

---

## 🔏 `/auth` and `/start` (WebReport)

Two WebReports call these endpoints from the browser (see [`webreports/README.md`](webreports/README.md): which node to
replace per environment, the rollout order and the QA checklist). Protocol **v2**:

1. `POST /auth` (Basic Auth: `START_AUTH_USER`/`START_AUTH_PASS`, or `LOG_USER`/`LOG_PASS`) with JSON
   `{workflowId, subworkflowId, nodeId, attachId, docName, userEmail1, userEmail2}` returns
   `{ v: 2, timestamp, nonce, signature }`. `nonce` is 16 random bytes (hex); `signature` is the HMAC-SHA256 (hex, key
   `SIGNATURE_SECRET`) of the canonical string
   `v2\n<timestamp>\n<nonce>\n<workflowId>\n<subworkflowId>\n<nodeId>\n<attachId>\n<emails>\n<docName>`, where
   `<emails>` are the e-mails of `userEmail1`/`userEmail2` (split on `;`/`,`), trimmed, lower-cased, sorted and joined by
   `,`; absent fields are empty strings (`canonicalStart` in `server/http/middleware/hmac.js`).
2. `POST /start` with the same fields (+ `taskId`, informative) and `timestamp`, `nonce`, `signature`. The server
   recomputes the canonical string from the body (constant-time comparison), requires the timestamp within 2 min and
   consumes the `nonce` (single use, table `start_nonces` in SQLite, expired ones purged on each insert). The nonce is
   consumed only after the signature is valid. Errors: `401` missing signature/timestamp, `400` malformed, `403`
   `Invalid signature.` / `Timestamp expired.` / `Solicitud ya utilizada.` (replay) / `Unsupported signature version.` (v1).

**Validation against the workflow** (`START_VERIFY_WORKFLOW=true`, default; the OTCS is the source of truth):
`workflowId` (numeric) is mandatory; the task named by `START_TASK_NAMES` must be `current` (else `409`
"El flujo no está en el paso de envío a firma."); its form (read with the integration user) provides `DocID`,
`AttachID`, the document name and the signers' e-mails (labels in `START_FIELD_*`; e-mails split on `;`/`,`). The agreement
uses **those** values and the `subprocessId`/`taskId` found in the OTCS. If the payload carries a different
`nodeId`/`attachId` or a different e-mail set (case-insensitive, any order): `409` "Los datos enviados no coinciden con el
flujo." (details only in the log). Missing `DocID`/`AttachID`/e-mails in the form: `422`. OTCS errors: `401/403` on the form
=> `409` "La tarea no está asignada al usuario de integración."; process `404` => `409` "Flujo no encontrado."; network
error/timeout/5xx => `503` "Content Server no disponible; intente nuevamente.".

**Order: send, confirm, then the page reassigns.** The WebReport calls `/start` first and only after it confirms the
agreement does the page itself (in the user's own OTCS session) run `WFTASKACTION:REASSIGN` to the integration user, so a
failed send or a closed page leaves the task in the user's inbox for a retry. The server therefore accepts the start task
while it is still assigned to the human user (`task_assignees` of `/v2/workflows/status/processes/{id}` compared with
`GET /v1/auth`):

- assigned to the integration user: the form is read, as before (the old WebReport, which reassigns at render time, keeps working);
- still with the human user, **standalone flow** (`subprocessId == processId`): `DocID`/`AttachID`/name/e-mails come from
  `GET /v2/workflows/status/info?workid={id}` (same labels, validation and payload check);
- still with the human user, **sub-workflow**: `409` `{ error: "La tarea debe asignarse al usuario de integración antes del envío.",
  code: "REASSIGN_REQUIRED", handoff }` and nothing is created (`status/info` only returns the parent's attributes and the form
  needs the task assigned to the integration user). The page must reassign first and call `/auth` + `/start` again.

Every `200` carries `handoff: { workflowId, subworkflowId, taskId, integrationUserId, assigned }` (numbers): what the page
reassigns when `assigned` is `false`. It is also returned with `existing: true` while the start task is still current (it is
omitted once the task has advanced, and without `START_VERIFY_WORKFLOW`). While the task is not assigned to the integration
user the background `SendOn` waits (no error log, normal retry backoff; when the attempts run out the agreement goes to
`needs_attention` asking to reopen the page). Repeating `/start` after the REASSIGN (`existing: true`) resumes the start
step immediately instead of waiting for the backoff.

**Idempotency** (only with the validation): if there is already a non-final agreement (no final result and no disposition
sent) for the same `workflowId` + resolved `subworkflowId` + `nodeId`, `/start` returns `200`
`{ message: "Signature already requested. ID: ...", id, existing: true }` and creates nothing (page reload after a network
error); it also applies when the start task has already advanced. With `START_VERIFY_WORKFLOW=false` the previous behaviour
is kept (the 15 min duplicate check applies in both modes).

**Legacy (migration window of the WebReports, OFF by default).** `START_LEGACY_SIGNATURE=true` accepts `GET /auth`
(timestamp only) and the v1 signature on `POST /start`; `START_LEGACY_GET_ENABLED=true` accepts the old
`GET /start?userEmail1=&userEmail2=&nodeId=&attachId=&docName=&workflowId=&subworkflowId=&taskId=` (no HMAC). Neither
binds the payload, so in these modes the validation against the OTCS is **always** applied, even with
`START_VERIFY_WORKFLOW=false`. Every use logs a `warn`. With the flags off, `GET /auth` and `GET /start` answer `404`
`{ "error": "Endpoint not found" }`.

**CORS.** Only `/auth` and `/start` (including the `OPTIONS` preflight). `CORS_ORIGINS` (comma list) defaults to the origin of
`OTCS_BASE`; `*` only if set explicitly. A disallowed origin gets no `Access-Control-Allow-Origin`. `/webhook`, `/admin/*`,
`/logs` and `/health` carry no CORS headers.

---

## 🛑 Flow cancellation

Ticket 2026060410003715 (details, decisions and open points: [`docs/DESIGN_TICKET_2026060410003715.md`](docs/DESIGN_TICKET_2026060410003715.md)).
A flow sent for signature that is no longer needed (resent, duplicated, wrong document) stays open in the Content Server
("Aguardar Firma") and in Adobe (`OUT_FOR_SIGNATURE`, with reminders). A **cancellation workflow** in the Content Server gets
the ID of the flow to cancel in its attributes and calls the orchestrator; the orchestrator cancels the Adobe agreement and
hands control back (SendOn of the cancellation workflow's own task), then the cancellation workflow cancels the original
flow in the Content Server. The orchestrator never touches the original flow.

**`POST /cancel`** (WebReport of the cancellation workflow; only with `CANCEL_ENABLED=true`, otherwise `404 { "error": "Endpoint not found" }`).
Same protocol as `/start`: `POST /auth` (Basic Auth) with `{workflowId, subworkflowId}` of the **cancellation workflow**
(`&WORKID`/`&SUBWORKID`) returns `{ v: 2, timestamp, nonce, signature }`; then `POST /cancel` with
`{workflowId, subworkflowId, timestamp, nonce, signature}` (HMAC v2, 2 min window, single-use nonce; the v1 signature is always refused here).
The target flow is **never** read from the body: the server re-reads the cancellation task in the OTCS (task named by
`CANCEL_TASK_NAMES`, must be `current` and assigned to `OTCS_USER`, else `409` — `REASSIGN_REQUIRED` carries a `handoff`
like `/start`) and takes the flow from its form attributes (`CANCEL_FIELD_TARGET_WORKFLOW`, optional
`CANCEL_FIELD_TARGET_SUBWORKFLOW`). Responses: `200 { message, id, alreadyCancelled }` (the task is sent on after the
cancellation is confirmed); `404` no agreement known for the flow (the old orchestrator's agreements must be adopted first with
`POST /admin/adopt/:id`); `409` ambiguous (several open agreements, with the list), already signed / not cancelable,
wrong step; `422` missing/invalid target attribute; `503` Adobe or OTCS unavailable (nothing marked) or `SENDON_FAILED`
(agreement cancelled, task not sent on: repeating is safe). Error bodies are `{ error, code, ... }`.

Rules: the open agreement is looked up by `workflowId` (and the exact `subworkflowId`, if given) — never the agreement of
another sub-process; the Adobe state is checked first (`CANCELLED`/`ABORTED` => idempotent, no new cancellation; `SIGNED` or
other final state => `409`); a failure from Adobe is transient and marks nothing. After a confirmed cancellation the agreement
is closed (`state=cancelled`, `sendon_done`, `cancel_requested_at`/`cancel_source`, event `CANCEL_REQUESTED`), so the
`AGREEMENT_RECALLED` that Adobe sends next (webhook, polling or retry queue) **does not** produce a `Rechazado` on the original
flow (default decision, reviewable). `otcsClient.stopProcess` (`PUT /v2/processes/{id}/status`, `stop`) exists but is not wired.

---

## 🔀 Webhook

- **Endpoint:** `/webhook` — `HEAD`/`GET` echo, in `X-AdobeSign-ClientId`, **the same value received** (Adobe requires the
  echo of what it sent; only `[A-Za-z0-9._-]`, up to 200 chars). Without the header (or with an invalid one) the
  configured `CLIENT_ID` is echoed. `POST` receives the events
- **Accepted ClientIds:** `CLIENT_ID` + `WEBHOOK_CLIENT_IDS`. A webhook created in the Adobe UI sends the ClientId of the
  application that created it, which is not the OAuth `CLIENT_ID` of this integration: list it in `WEBHOOK_CLIENT_IDS`.
  A mismatch only logs a `warn`, unless `WEBHOOK_REQUIRE_CLIENT_ID=true` (then `401`, nothing persisted)
- **Content-Type:** `application/json`

The `POST` persists the event (deduplicated by `webhookNotificationId`) and answers `200` with
`X-AdobeSign-ClientId` immediately; confirming `SIGNED`, downloading the PDF, writing it to OTCS and executing the
disposition run in the background and are retried with exponential backoff (1 min ... 1 h). A poller
(`POLL_INTERVAL_MS`) also re-checks agreements that never received a final event, and reopens `needs_attention`
agreements whose retries were exhausted after `ATTENTION_RETRY_HOURS`. Event policy (Adobe Sign v6 names); the full
rules (states, stages, retry/attention/reopen, adoption) are in [`docs/REGLAS_DEL_FLUJO.md`](docs/REGLAS_DEL_FLUJO.md):

| Event | Action |
|---|---|
| `AGREEMENT_WORKFLOW_COMPLETED` (or `AGREEMENT_ACTION_COMPLETED` with `agreement.status = SIGNED`) | write the final PDF (with audit report) as a **new version of the same node** (`nodeId`) that was sent to sign — folder `attachId` only as a fallback if the node no longer exists — then disposition `Firmado` on the signing task |
| `AGREEMENT_REJECTED` | disposition `Rechazado` (no PDF) |
| `AGREEMENT_EXPIRED`, `AGREEMENT_RECALLED`, `AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM` | disposition `DISPOSITION_*` (default `Rechazado`, the only other action in the maps); empty => `needs_attention`. Exception: an agreement closed by a cancellation request (see "Flow cancellation") ignores the `RECALLED` echo — history only |
| `AGREEMENT_DOCUMENTS_DELETED` | `needs_attention` |
| informational / unavailable / unknown events | history only |

Adobe is the source of truth for every final result, from a webhook or from polling: before the PDF is delivered or the
disposition is sent, the agreement is fetched from Adobe and must confirm the result. An in-progress status retries with
backoff; another final result on Adobe replaces the one stored from the webhook or polling; anything without a final result
(`ABORTED` outside conversion failures, an unknown or an empty status) goes to `needs_attention` (`unconfirmed`), and so
does a result that cannot replace the stored one because the PDF was already delivered. A `CANCELLED` status is told apart
from a recall through `GET /agreements/{id}/events`: `REJECTED`/`ACTION_REJECTED` means rejected, otherwise it is a recall.
A webhook that changes an already stored result clears the stored Adobe status, so the agreement is fetched again; a status
already stored by a previous fetch that confirms the result is not fetched again.

Legacy names (`AGREEMENT_COMPLETED`, `AGREEMENT_SIGNED`, `DOCUMENT_SIGNED`, `PARTICIPANT_*`) are accepted as aliases.

PDF delivery records `Adobe Sign: <agreementId>` in the version description (or the node description for a new fallback
document). Retries check this remote marker before writing, including after a lost response or restart before SQLite
confirmed delivery. Keep the marker intact until reconciliation completes. This also protects delivery after adoption;
it does not provide an atomic lock against other processes writing the same node.

### Admin endpoints (Basic Auth `LOG_USER`/`LOG_PASS`)

- `GET /admin/agreements[?state=needs_attention][&events=5]` — state of every agreement
- `POST /admin/reconcile/:id` — force a reconciliation (asks Adobe if no final result is known yet); also takes a
  `needs_attention` agreement back and resets its attempts. Optional JSON body `{ "subworkflowId": "<digits>" }` first
  corrects the sub-process stored on the agreement (use it when the task exists in several sub-processes of the same
  parent and the agreement does not say which one); `422` if not numeric, `409` if the agreement is already concluded
- `POST /admin/adopt/:id` — registers an Adobe agreement that is not in SQLite (lost ephemeral database, new deploy) and
  reconciles it. It uses the agreement's `externalId` (`otcs|wf=..|sub=..|node=..|attach=..`, set by `/start` since this
  version); for older agreements send JSON `{ "workflowId", "subworkflowId"?, "nodeId", "attachId", "fileName"? }`.
  `409` if already registered, `422` if data is missing, `404` if the agreement does not exist in Adobe. The webhook does
  the same automatically for unknown agreements with our `externalId` (`ADOPT_UNKNOWN_AGREEMENTS`). Adopted agreements
  enter the retry queue to check the start task in OTCS, sending it on only if still active. This also recovers a
  restart before the initial SendOn, including with `POLL_ENABLED=false`.
- `POST /admin/cancel/:agreementId` — cancels one agreement known to the orchestrator on Adobe (optional JSON `{ "comment" }`)
  and closes it without a disposition on the original flow. Idempotent: an agreement already `CANCELLED` on Adobe is not
  cancelled again; `SIGNED` or another final state => `409`; Adobe failure => `503` and nothing is marked (if the cancel call fails
  the agreement is read again: `CANCELLED`/`ABORTED` means Adobe applied it and only the response was lost, so it counts as
  confirmed); unknown agreement => `404` with a hint to adopt it. Works regardless of `CANCEL_ENABLED`.
- `POST /admin/cancel-workflow/:workflowId` — same for the open agreement of a flow. Optional JSON `{ "subworkflowId", "comment" }`;
  several open agreements without `subworkflowId` => `409` `AMBIGUOUS` with the list and nothing is cancelled; none => `404`.
- **Both `/admin/cancel*` routes leave the Content Server flow untouched.** They cancel on Adobe and close the agreement without a
  disposition, so the original workflow stays in "Aguardar Firma": the `200` carries `contentFlow: "unchanged"` and a Spanish
  `note` ("El flujo del Content Server no fue modificado: deténgalo en el Content o ejecute el workflow de cancelación"), and a `warn`
  with the `workflowId`/`subworkflowId` is logged. `Rechazado` is deliberately not sent: the Rechazado branch of the maps may fire
  business actions that are not "cancel". Reviewable alternative: a future option to close the original through `stopProcess`.
- `GET /logs`, `GET /logs/stream` — today's `audit-YYYY-MM-DD.log` (download / live SSE)
- `GET /admin/login` (Basic Auth) — Adobe OAuth consent with a random one-time `state` (10 min); `GET /admin/callback` —
  Adobe's redirect (no Basic Auth, requires a valid `state`); `GET /health` — liveness

---

## 📁 Folder Structure

```
/
├── .env                  # Environment variables (not committed)
├── package.json
├── readme.md
├── template.html         # WebReport "Requisicion de Firma" (pure flow): POST /auth + POST /start (v2)
├── webreports/           # WebReport of the hiring sub-flow + README (rollout, per-environment changes, QA checklist)
├── static/               # logs viewer (logs.html/js/css)
├── docs/                 # design notes (DESIGN_TICKET_2026062210004476.md, DESIGN_TICKET_2026060410003715.md) and flow rules (REGLAS_DEL_FLUJO.md)
├── deploy/openshift/     # PVC + README (example)
├── test/                 # node:test suites + fakes (test/support)
├── data/                 # local state (git-ignored): state/, logs/, inprocess/
│
└── server/
    ├── index.js          # entrypoint: wires real dependencies, poller, listen, keepalive
    ├── app.js            # createApp(deps): Express app with injected dependencies
    ├── config/           # env -> config, storage selection per platform
    ├── domain/           # pure functions: eventPolicy (events), agreementState (state machine), workflowSteps (task lookup by name), externalId, cancellation
    ├── infra/            # SQLite (db, agreementRepository, legacyImport), tokenStore, adobeClient, otcsClient, logger
    ├── services/         # reconciliationService (start -> verify -> PDF -> disposition), signatureService (/start), cancellationService (/cancel), poller
    ├── http/             # routes (webhook, start, cancel, admin, logs) and middleware (hmac, basicAuth)
    └── serverModules/
        └── backend.js    # shim kept for `node server/serverModules/backend.js`
```

---

## 🧠 Technical Insights

- Uses Adobe Sign OAuth 2.0 with refresh token to avoid frequent re-authentication.
- Replaces public URL method with OTDS authentication for secure, restricted environments.
- Temporarily stores files with optional weekly cleanup.
- All mapping and tracking logic is managed by the SQLite database (`state/orchestrator.db`): agreement -> node/workflow map, recipients and creation dates (duplicate check), per-agreement state (`pending -> signed -> pdf_delivered -> completed`, or `rejected/expired/cancelled/needs_attention`) and event history.

---

## 🛡️ Security

- No sensitive tokens are exposed on the frontend. The WebReport only holds the Basic credential of `/auth` (use `START_AUTH_*`, which does not open `/admin` or `/logs`); the HMAC key never leaves the server.
- `/start` cannot be forged from the browser: the signature binds the request fields, expires in 2 min and its nonce is single use; the server re-reads the workflow in the OTCS and uses those values (from the start task form when the integration user holds it, or from the workflow attributes while a standalone task is still with the user; the `SendOn` only happens once the integration user holds the task).
- CORS is limited to `/auth`, `/start` and (only with `CANCEL_ENABLED=true`) `/cancel`, and to the OTCS origin (`CORS_ORIGINS`). `/cancel` never takes the target flow from the browser: it comes from the cancellation task form in the OTCS.
- Passwords and keys are read from the `.env` file.
- Webhook filters out irrelevant events and only processes mapped agreements; events are deduplicated and failures are retried, never swallowed.

---

## 🧊 Testing

- Compatible with protected documents
- Supports multiple signers

---

## 🧙‍♂️ Developer

This project was fully built by **Pedro Barone**, from scratch, without external help in the name of Stratesys, allocated on a project for Keralty. 
I was responsible for:

- Designing the API architecture
- Implementing secure OAuth2 authentication (Adobe Sign)
- Integrating with OpenText Content Server (OTCS)
- Building all endpoints and background tasks
- Handling file streaming and asynchronous webhook events
- Logging, error handling, and cleanup routines
- Deployment and environment configuration
---

## 📄 License

This project is for internal use by Stratesys employees only. Any unauthorized copies are illegal according to copyright laws. 
