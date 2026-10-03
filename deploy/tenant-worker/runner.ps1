# The pwsh side of the tenant worker: one long-lived Exchange Online session, driven by server.mjs
# over stdin and stdout, one request at a time. Each request is a JSON line
#   {"id":1,"op":"get_accepted_domain","tenant":{"appId":"...","organization":"<TENANT>.onmicrosoft.com"},"args":{"domain":"<DOMAIN>"}}
# and each answer a line starting with the marker below:
#   @@TW@@{"id":1,"ok":true,"result":[...]}   or   @@TW@@{"id":1,"ok":false,"error":{"code":"...","message":"..."}}
# A cmdlet's result is always a JSON array ([] for none). Anything else pwsh writes to stdout
# (module warnings) is not an answer; server.mjs logs it.
#
# server.mjs checks every operation and value against its whitelist (ops.mjs) before writing the
# line; this script checks them again (the same table and patterns, runner.lib.ps1) and calls the
# cmdlet with the values splatted as parameters. No command text is built from a value, and no
# other cmdlet can be reached: Connect-ExchangeOnline -CommandName loads only the whitelist's
# cmdlets (R-36).
#
# -DryRun prints the commands instead of running them (tests, the stand): the answer's result is
# { dryRun, commands: [{ cmdlet, parameters }] }, the connect included on the first call, its
# certificate password shown as <redacted>.
param([switch]$DryRun)

$script:DryRun = [bool]$DryRun
. (Join-Path $PSScriptRoot 'runner.lib.ps1')

if (-not $script:DryRun) {
  Import-Module ExchangeOnlineManagement -ErrorAction Stop
}
Write-Answer @{ id = 0; ok = $true; result = @{ ready = $true; dryRun = $script:DryRun } }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json -ErrorAction Stop
    $id = $request.id
    $answer = Invoke-Op $request
  } catch {
    $answer = @{ ok = $false; error = (Get-Failure 'runner_failed' $_.Exception.Message) }
  }
  $answer.id = $id
  Write-Answer $answer
}

if ($script:EverConnected -and -not $script:DryRun) {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}
