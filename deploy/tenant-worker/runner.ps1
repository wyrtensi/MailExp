# The pwsh side of the tenant worker: one long-lived Exchange Online session, driven by server.mjs
# over stdin and stdout, one request at a time. Each request is a JSON line
#   {"id":1,"op":"get_accepted_domain","tenant":{"appId":"...","organization":"<TENANT>.onmicrosoft.com"},"args":{"domain":"<DOMAIN>"}}
# and each answer a line starting with the marker below:
#   @@TW@@{"id":1,"ok":true,"result":...}   or   @@TW@@{"id":1,"ok":false,"error":{"code":"...","message":"..."}}
# Anything else pwsh writes to stdout (module warnings) is not an answer; server.mjs logs it.
#
# server.mjs checks every operation and value against its whitelist (ops.mjs) before writing the
# line; this script checks them again (the same table and patterns) and calls the cmdlet with the
# values splatted as parameters. No command text is built from a value, and no other cmdlet can be
# reached: Connect-ExchangeOnline -CommandName loads only the whitelist's cmdlets (R-36).
#
# -DryRun prints the commands instead of running them (tests, the stand): the answer's result is
# { dryRun, commands: [{ cmdlet, parameters }] }, the connect included on the first call, its
# certificate password shown as <redacted>.
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Marker = '@@TW@@'

$DomainPattern = '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
$GuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# op -> the cmdlet, its fixed parameters, the request arguments it takes (argument -> parameter and
# pattern), and the properties kept in the answer.
$Ops = @{
  whoami = @{
    Cmdlet = 'Get-OrganizationConfig'; Fixed = @{}; Args = @{}
    Keep = @('Name', 'DisplayName', 'Identity', 'Guid')
  }
  get_blocked_connector = @{
    Cmdlet = 'Get-BlockedConnector'; Fixed = @{}; Args = @{}
    Keep = @('ConnectorId', 'ConnectorName', 'TenantId', 'Reason', 'CreatedTime', 'ExpirationTime')
  }
  get_content_filter_policy = @{
    Cmdlet = 'Get-HostedContentFilterPolicy'; Fixed = @{ Identity = 'Default' }; Args = @{}
    Keep = @('Identity', 'IsDefault', 'SpamAction', 'HighConfidenceSpamAction', 'PhishSpamAction',
      'HighConfidencePhishAction', 'BulkSpamAction', 'BulkThreshold', 'QuarantineRetentionPeriod',
      'RedirectToRecipients', 'WhenChanged')
  }
  get_accepted_domain = @{
    Cmdlet = 'Get-AcceptedDomain'; Fixed = @{}; Args = @{ domain = @('Identity', $DomainPattern) }
    Keep = @('DomainName', 'DomainType', 'Default', 'Identity')
  }
}
$CommandNames = @($Ops.Values | ForEach-Object { $_.Cmdlet } | Sort-Object -Unique)

$script:Session = $null

function Write-Answer($answer) {
  [Console]::Out.WriteLine($Marker + ($answer | ConvertTo-Json -Depth 6 -Compress))
  [Console]::Out.Flush()
}

function Get-Failure([string]$code, [string]$message) {
  return [ordered]@{ code = $code; message = $message.Substring(0, [Math]::Min(500, $message.Length)) }
}

# A value as JSON keeps it: enums and dates become strings, collections arrays.
function ConvertTo-Plain($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [datetime]) { return $value.ToUniversalTime().ToString('o') }
  if ($value -is [string] -or $value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double]) { return $value }
  if ($value -is [System.Collections.IEnumerable]) { return @($value | ForEach-Object { ConvertTo-Plain $_ }) }
  return $value.ToString()
}

function Select-Kept($items, $keep) {
  return @($items | ForEach-Object {
      $item = $_
      $row = [ordered]@{}
      foreach ($name in $keep) {
        $prop = $item.PSObject.Properties[$name]
        if ($prop) { $row[$name] = ConvertTo-Plain $prop.Value }
      }
      $row
    })
}

function Connect-Tenant($tenant, $commands) {
  $appId = [string]$tenant.appId
  $organization = [string]$tenant.organization
  if ($appId -notmatch $GuidPattern -or $organization -notmatch $DomainPattern -or -not $organization.EndsWith('.onmicrosoft.com')) {
    throw [System.ArgumentException]::new('invalid_tenant')
  }
  $key = "$appId|$organization"
  if ($script:Session -eq $key) { return }
  $parameters = [ordered]@{
    AppId = $appId; Organization = $organization; CertificateFilePath = $env:TENANT_PFX_PATH
    CertificatePassword = '<redacted>'; CommandName = $CommandNames; SkipLoadingFormatData = $true; ShowBanner = $false
  }
  if ($DryRun) {
    $commands.Add([ordered]@{ cmdlet = 'Connect-ExchangeOnline'; parameters = $parameters })
    $script:Session = $key
    return
  }
  if ($script:Session) {
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    $script:Session = $null
  }
  $raw = (Get-Content -Raw -LiteralPath $env:TENANT_PFX_PASSWORD_FILE) -replace '[\r\n]+$', ''
  $parameters.CertificatePassword = ConvertTo-SecureString -String $raw -AsPlainText -Force
  $raw = $null
  Connect-ExchangeOnline @parameters | Out-Null
  $script:Session = $key
}

function Invoke-Op($request) {
  $op = [string]$request.op
  if (-not $Ops.ContainsKey($op)) { return @{ ok = $false; error = (Get-Failure 'unknown_op' 'Unknown operation') } }
  $spec = $Ops[$op]
  $parameters = [ordered]@{}
  foreach ($entry in $spec.Fixed.GetEnumerator()) { $parameters[$entry.Key] = $entry.Value }
  $given = $request.args
  if ($given) {
    foreach ($prop in $given.PSObject.Properties) {
      if (-not $spec.Args.ContainsKey($prop.Name)) { return @{ ok = $false; error = (Get-Failure 'invalid_args' 'Unknown argument') } }
    }
  }
  foreach ($entry in $spec.Args.GetEnumerator()) {
    $value = if ($given) { $given.PSObject.Properties[$entry.Key].Value } else { $null }
    if ($value -isnot [string] -or $value -cnotmatch $entry.Value[1]) {
      return @{ ok = $false; error = (Get-Failure 'invalid_args' "Argument $($entry.Key) is invalid") }
    }
    $parameters[$entry.Value[0]] = $value
  }
  $commands = [System.Collections.Generic.List[object]]::new()
  try {
    Connect-Tenant $request.tenant $commands
  } catch {
    if ($_.Exception.Message -eq 'invalid_tenant') { return @{ ok = $false; error = (Get-Failure 'invalid_tenant' 'Tenant is invalid') } }
    $script:Session = $null
    return @{ ok = $false; error = (Get-Failure 'exo_connect_failed' $_.Exception.Message) }
  }
  if ($DryRun) {
    $commands.Add([ordered]@{ cmdlet = $spec.Cmdlet; parameters = $parameters })
    return @{ ok = $true; result = [ordered]@{ dryRun = $true; commands = $commands } }
  }
  $cmdlet = $spec.Cmdlet
  for ($attempt = 1; ; $attempt++) {
    try {
      $items = & $cmdlet @parameters
      return @{ ok = $true; result = (Select-Kept $items $spec.Keep) }
    } catch {
      $message = $_.Exception.Message
      # A session that expired or dropped: connect again once and repeat the read.
      if ($attempt -eq 1 -and $message -match 'session|token|connect|unauthori|expired') {
        $script:Session = $null
        try { Connect-Tenant $request.tenant $commands } catch { return @{ ok = $false; error = (Get-Failure 'exo_connect_failed' $_.Exception.Message) } }
        continue
      }
      $code = if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $message -match "couldn't be found|not found") { 'exo_not_found' } else { 'exo_failed' }
      return @{ ok = $false; error = (Get-Failure $code $message) }
    }
  }
}

if (-not $DryRun) {
  Import-Module ExchangeOnlineManagement -ErrorAction Stop
}
Write-Answer @{ id = 0; ok = $true; result = @{ ready = $true; dryRun = [bool]$DryRun } }

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

if ($script:Session -and -not $DryRun) {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}
