# Sobe o orquestrador local SEMPRE pelo cluster (kind "openshift-local", namespace orquestrador-firmas) e abre o ngrok
# para o ingress do cluster. Nada roda com npm start nem em janela do CMD.
#   powershell -ExecutionPolicy Bypass -File start.ps1
# Primeira vez, ou depois de mudar o código ou o .env: deploy\openshift\qa\deploy-local.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$Ns = "orquestrador-firmas"
$Domain = "legible-chipmunk-only.ngrok-free.app"
$ClusterScript = Join-Path $env:USERPROFILE "Desktop\openshift\scripts\03-start.ps1"

Write-Host "== 1. cluster =="
& $ClusterScript
kubectl config use-context kind-openshift-local | Out-Null

Write-Host "`n== 2. orquestrador =="
if (-not (kubectl get deploy signature-orchestrator -n $Ns --ignore-not-found -o name)) {
    throw "Deployment não encontrado em $Ns. Rode antes: deploy\openshift\qa\deploy-local.ps1"
}
# Garante 1 réplica (pode ter sido escalado a 0) e espera o pod ficar pronto depois do restart do cluster
kubectl scale deploy/signature-orchestrator -n $Ns --replicas=1 | Out-Null
kubectl rollout status deploy/signature-orchestrator -n $Ns --timeout=180s
if ($LASTEXITCODE -ne 0) { throw "O pod não ficou pronto. Veja: kubectl logs deploy/signature-orchestrator -n $Ns" }

# O ingress pode levar alguns segundos a mais que o pod depois de o cluster subir
$deadline = (Get-Date).AddMinutes(2)
do {
    $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 5 "http://orquestrador-firmas.apps.localtest.me/health"
    if ($code -eq "200") { break }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)
if ($code -ne "200") { throw "/health pela Route local respondeu '$code'" }
Write-Host "Route local ok: http://orquestrador-firmas.apps.localtest.me/health"

Write-Host "`n== 3. ngrok -> ingress do cluster (porta 80) =="
# O plano free aceita um só agente por domínio: encerra o anterior antes de abrir outro
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
# O ngrok mantém o Host do domínio, e a Route signature-orchestrator tem esse host
Start-Process -FilePath powershell.exe -ArgumentList "-NoExit", "-Command",
    "`$Host.UI.RawUI.WindowTitle = 'Ngrok'; ngrok http 80 --url=https://$Domain"

$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Seconds 2
    $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 10 "https://$Domain/health"
} while ($code -ne "200" -and (Get-Date) -lt $deadline)
if ($code -ne "200") { throw "/health pelo ngrok respondeu '$code'. Veja a janela Ngrok e http://127.0.0.1:4040" }

Write-Host "`nPronto."
Write-Host "  Público:  https://$Domain"
Write-Host "  Webhook:  https://$Domain/webhook"
Write-Host "  Local:    http://orquestrador-firmas.apps.localtest.me"
Write-Host "  Inspetor: http://127.0.0.1:4040"
Write-Host "  Logs:     kubectl logs -f deploy/signature-orchestrator -n $Ns"
