# Build, carga no kind e deploy do orquestrador no cluster local (ambiente deploy/openshift/qa).
# Rodar da raiz do repositório:  powershell -ExecutionPolicy Bypass -File deploy\openshift\qa\deploy-local.ps1
# O cluster precisa estar de pé (Desktop\openshift\scripts\start-cluster.ps1).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
Set-Location $Root
$Ns = "orquestrador-firmas"

docker build -f deploy/openshift/Containerfile -t signature-orchestrator:local .
if ($LASTEXITCODE -ne 0) { throw "falhou o build da imagem" }
kind load docker-image signature-orchestrator:local --name openshift-local
if ($LASTEXITCODE -ne 0) { throw "falhou o kind load" }

if (-not (kubectl get namespace $Ns --ignore-not-found -o name)) { kubectl create namespace $Ns }

# Secret só com as chaves sensíveis do .env; o resto vem do ConfigMap. Os valores não passam pelo console.
$keys = "CLIENT_ID,CLIENT_SECRET,SIGNATURE_SECRET,LOG_USER,LOG_PASS,START_AUTH_USER,START_AUTH_PASS,OTCS_USER,OTCS_PASS,ADOBE_REFRESH_TOKEN"
$secretJson = node -e @'
const env = require('dotenv').parse(require('fs').readFileSync('.env'));
const stringData = {};
for (const k of process.argv[1].split(',')) stringData[k] = env[k] || '';
process.stdout.write(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name: 'signature-orchestrator-env', labels: { app: 'signature-orchestrator' } }, stringData }));
'@ $keys
if ($LASTEXITCODE -ne 0) { throw "falhou a leitura do .env" }
# Recria o Secret: o apply com stringData não apaga chaves que saíram da lista (ficariam valendo no pod)
kubectl delete secret signature-orchestrator-env -n $Ns --ignore-not-found | Out-Null
$secretJson | kubectl apply -n $Ns -f -
if ($LASTEXITCODE -ne 0) { throw "falhou o Secret" }

kubectl apply -k deploy/openshift/qa
if ($LASTEXITCODE -ne 0) { throw "falhou o apply" }
# Mesma tag "local" a cada build: força pod novo para pegar a imagem recém-carregada
kubectl rollout restart deploy/signature-orchestrator -n $Ns
kubectl rollout status deploy/signature-orchestrator -n $Ns --timeout=180s
kubectl get pods,route -n $Ns
