# Generic status push for any tool (Claude / Grok / Cursor / manual)
# Example:
#   .\send-event.ps1 -Source claude-code -State editing -Title "Editing a.ts"
#   .\send-event.ps1 -Source grok -State thinking -Title "Grok is working"

param(
  [ValidateSet("idle","thinking","tool_call","editing","waiting_user","running_tests","success","error")]
  [string]$State = "thinking",
  [string]$Title = "Working",
  [string]$Detail = "",
  [string]$Source = "manual",
  [string]$Url = "http://127.0.0.1:7788/event"
)

$bodyObj = [ordered]@{
  schema         = "petdeck.event.v1"
  source         = $Source
  sessionId      = "$Source-session"
  ts             = (Get-Date).ToUniversalTime().ToString("o")
  state          = $State
  title          = $Title
  progress       = @{ kind = $(if ($State -eq "idle" -or $State -eq "success") { "none" } else { "indeterminate" }) }
  needsAttention = ($State -eq "waiting_user" -or $State -eq "error")
  stickyMs       = $(if ($State -eq "idle") { 0 } elseif ($State -eq "success") { 2000 } elseif ($State -eq "waiting_user") { 60000 } else { 5000 })
}
if ($Detail) { $bodyObj.detail = $Detail }

$body = $bodyObj | ConvertTo-Json -Compress -Depth 5
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($env:PETDECK_BRIDGE_TOKEN)) {
  $headers["X-PetDeck-Token"] = $env:PETDECK_BRIDGE_TOKEN.Trim()
}

try {
  Invoke-RestMethod -Uri $Url -Method POST -Body $body -ContentType "application/json; charset=utf-8" -Headers $headers | Out-Null
  Write-Host "OK  [$Source] $State — $Title"
} catch {
  Write-Host "FAIL — is PetDeck running? $_"
  exit 1
}
