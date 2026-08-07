# Manual test: send a sample event to PetDeck bridge (PetDeck must be running)
param(
  [string]$State = "editing",
  [string]$Title = "Editing auth.ts",
  [string]$Detail = "src/lib/auth.ts"
)

$body = @{
  schema = "petdeck.event.v1"
  source = "claude-code"
  sessionId = "manual-test"
  ts = (Get-Date).ToUniversalTime().ToString("o")
  state = $State
  title = $Title
  detail = $Detail
  progress = @{ kind = "indeterminate" }
  needsAttention = ($State -eq "waiting_user" -or $State -eq "error")
} | ConvertTo-Json -Compress
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($env:PETDECK_BRIDGE_TOKEN)) {
  $headers["X-PetDeck-Token"] = $env:PETDECK_BRIDGE_TOKEN.Trim()
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:7788/event" -Method POST -Body $body -ContentType "application/json" -Headers $headers
  Write-Host "OK -> $State : $Title"
} catch {
  Write-Host "FAILED (is PetDeck running?): $_"
  exit 1
}
