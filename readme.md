# 🔐 Adobe Sign + OpenText xECM Integration
A RESTful API built for orchestrating electronic document signature workflows via Adobe Sign, with full integration to OpenText Content Server (OTCS).  
Exposes endpoints to trigger document signing, monitor status via webhooks, and automate document storage — with full support for OAuth, multiple recipients, and workflow transitions.

## 📌 Purpose

This project enables the sending of documents from OTCS to Adobe Sign for electronic signatures, automatic retrieval of the signed document, and final upload to the correct folder in the Content Server — all via API, with no manual intervention.

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
- 📄 Automatic upload of the signed PDF to the designated folder in OTCS
- 🗒️ Detailed logging (daily `audit-YYYY-MM-DD.log` / `error-YYYY-MM-DD.log`, 15-day retention)
- 🧼 Optional purge of temporary files
- ⛔ Duplicate check: prevents resending the same document to the same recipients within 15 minutes
- 🔒 Signature authentication via HMAC with timestamp (anti-replay)
- 🔐 /auth endpoint protected with Basic Auth to restrict public key access
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
SIGN_TASK_ID=3                                     # task that receives the final disposition

# Security (required)
SIGNATURE_SECRET=hmac_secret_shared_with_the_webreport
LOG_USER=basic_auth_user                           # Basic Auth for /auth, /logs, /admin/agreements, /admin/reconcile
LOG_PASS=basic_auth_password

# Disposition names in the OTCS workflow (custom_action)
DISPOSITION_SIGNED=Firmado
DISPOSITION_REJECTED=Rechazado
DISPOSITION_EXPIRED=                  # empty => agreement goes to needs_attention
DISPOSITION_RECALLED=                 # empty => needs_attention
DISPOSITION_CONVERSION_FAILED=        # empty => needs_attention

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
ADOBE_DOWNLOAD_ATTEMPTS=8             # retries of 403 on combinedDocument right after signing
LOG_RETENTION_DAYS=15                 # 0 disables the purge
OTCS_TIMEOUT_MS=60000
KEEPALIVE_INTERVAL_MS=600000          # self-ping of /health when NODE_ENV=production (0 disables)
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

### 4. Start the server

```bash
npm start      # node server/index.js
npm test       # node --test (fakes for Adobe/OTCS, in-memory SQLite)
```

`better-sqlite3` is a native addon: `npm install` downloads a prebuilt binary when available, otherwise it needs
python3, make and g++ to compile.

---

## 🔀 Webhook

- **Endpoint:** `/webhook` — `HEAD`/`GET` echo `X-AdobeSign-ClientId` (verification handshake); `POST` receives the events
- **Content-Type:** `application/json`

The `POST` persists the event (deduplicated by `webhookNotificationId`) and answers `200` with
`X-AdobeSign-ClientId` immediately; downloading the PDF, uploading it to OTCS and executing the disposition run in the
background and are retried with exponential backoff (1 min ... 1 h). A poller (`POLL_INTERVAL_MS`) also re-checks
agreements that never received a final event. Event policy (Adobe Sign v6 names):

| Event | Action |
|---|---|
| `AGREEMENT_WORKFLOW_COMPLETED` (or `AGREEMENT_ACTION_COMPLETED` with `agreement.status = SIGNED`) | upload the final PDF (with audit report) as a new version in `attachId`, then disposition `Firmado` |
| `AGREEMENT_REJECTED` | disposition `Rechazado` (no PDF) |
| `AGREEMENT_EXPIRED`, `AGREEMENT_RECALLED`, `AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM` | configurable disposition (`DISPOSITION_*`); empty => `needs_attention` |
| `AGREEMENT_DOCUMENTS_DELETED` | `needs_attention` |
| informational / unavailable / unknown events | history only |

Legacy names (`AGREEMENT_COMPLETED`, `AGREEMENT_SIGNED`, `DOCUMENT_SIGNED`, `PARTICIPANT_*`) are accepted as aliases.

### Admin endpoints (Basic Auth `LOG_USER`/`LOG_PASS`)

- `GET /admin/agreements[?state=needs_attention][&events=5]` — state of every agreement
- `POST /admin/reconcile/:id` — force a reconciliation (asks Adobe if no final result is known yet)
- `GET /logs`, `GET /logs/stream` — today's `audit-YYYY-MM-DD.log` (download / live SSE)
- `GET /admin/login`, `GET /admin/callback` — Adobe OAuth (no auth, as before); `GET /health` — liveness

---

## 📁 Folder Structure

```
/
├── .env                  # Environment variables (not committed)
├── package.json
├── readme.md
├── template.html         # WebReport page that calls /auth and /start
├── static/               # logs viewer (logs.html/js/css)
├── docs/                 # design notes (DESIGN_TICKET_2026062210004476.md)
├── deploy/openshift/     # PVC + README (example)
├── test/                 # node:test suites + fakes (test/support)
├── data/                 # local state (git-ignored): state/, logs/, inprocess/
│
└── server/
    ├── index.js          # entrypoint: wires real dependencies, poller, listen, keepalive
    ├── app.js            # createApp(deps): Express app with injected dependencies
    ├── config/           # env -> config, storage selection per platform
    ├── domain/           # pure functions: eventPolicy (events), agreementState (state machine)
    ├── infra/            # SQLite (db, agreementRepository, legacyImport), tokenStore, adobeClient, otcsClient, logger
    ├── services/         # reconciliationService (PDF -> disposition), signatureService (/start), poller
    ├── http/             # routes (webhook, start, admin, logs) and middleware (hmac, basicAuth)
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

- No sensitive tokens are exposed on the frontend.
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
