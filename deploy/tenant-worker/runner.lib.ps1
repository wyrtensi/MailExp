# The functions of the pwsh runner (runner.ps1), apart so tests can load them without the
# ExchangeOnlineManagement module: worker.test.mjs dot-sources this file, stubs the cmdlets and
# checks what Invoke-Op answers for 0, 1 and 2 items.
#
# Arrays: PowerShell unrolls what a function returns and what a pipeline yields (one item comes
# back bare, none comes back as $null). Every list here is collected into a List and returned with
# the unary comma, and cmdlet output is wrapped in @(), so an answer is always a JSON array: [] for
# none, [ {...} ] for one.
#
# $script:DryRun must be set before this file is loaded (runner.ps1 sets it from -DryRun).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Marker = '@@TW@@'

# \z, not $: in .NET $ also matches before a trailing line break.
$DomainPattern = '^(?=.{1,253}\z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\z'
$GuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
# What an EXO error says when the session itself is gone (an expired token, a dropped connection),
# as opposed to the operation failing: then the runner connects again once and repeats the read.
# Word-bounded, so "connector" in an error of Get-BlockedConnector is not a session error.
$SessionErrorPattern = '\bsession\b|\btoken\b|\bnot connected\b|\bconnection\b|\bunauthori[sz]ed\b|\b401\b'

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
$script:EverConnected = $false

function Write-Answer($answer) {
  [Console]::Out.WriteLine($Marker + ($answer | ConvertTo-Json -Depth 6 -Compress))
  [Console]::Out.Flush()
}

function Get-Failure([string]$code, [string]$message) {
  return [ordered]@{ code = $code; message = $message.Substring(0, [Math]::Min(500, $message.Length)) }
}

# A value as JSON keeps it: enums and dates become strings, collections arrays (one element stays an
# array, an empty one stays []).
function ConvertTo-Plain($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [datetime]) { return $value.ToUniversalTime().ToString('o') }
  if ($value -is [string] -or $value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double]) { return $value }
  if ($value -is [System.Collections.IEnumerable]) {
    $list = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $value) { if ($null -ne $item) { $list.Add((ConvertTo-Plain $item)) } }
    return , $list.ToArray()
  }
  return $value.ToString()
}

# The kept properties of each item, always as an array.
function Select-Kept($items, $keep) {
  $rows = [System.Collections.Generic.List[object]]::new()
  foreach ($item in @($items)) {
    if ($null -eq $item) { continue }
    $row = [ordered]@{}
    foreach ($name in $keep) {
      $prop = $item.PSObject.Properties[$name]
      if ($prop) { $row[$name] = ConvertTo-Plain $prop.Value }
    }
    $rows.Add($row)
  }
  return , $rows.ToArray()
}

function Connect-Tenant($tenant, $commands) {
  $appId = [string]$tenant.appId
  $organization = [string]$tenant.organization
  if ($appId -cnotmatch $GuidPattern -or $organization -cnotmatch $DomainPattern -or -not $organization.EndsWith('.onmicrosoft.com')) {
    throw [System.ArgumentException]::new('invalid_tenant')
  }
  $key = "$appId|$organization"
  if ($script:Session -eq $key) { return }
  $parameters = [ordered]@{
    AppId = $appId; Organization = $organization; CertificateFilePath = $env:TENANT_PFX_PATH
    CertificatePassword = '<redacted>'; CommandName = $CommandNames; SkipLoadingFormatData = $true; ShowBanner = $false
  }
  if ($script:DryRun) {
    $commands.Add([ordered]@{ cmdlet = 'Connect-ExchangeOnline'; parameters = $parameters })
    $script:Session = $key
    return
  }
  # A session dropped after an error (Session $null) may still be open: close it before the next.
  if ($script:EverConnected) {
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    $script:Session = $null
  }
  $raw = (Get-Content -Raw -LiteralPath $env:TENANT_PFX_PASSWORD_FILE) -replace '[\r\n]+\z', ''
  $parameters.CertificatePassword = ConvertTo-SecureString -String $raw -AsPlainText -Force
  $raw = $null
  $script:EverConnected = $true
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
  if ($script:DryRun) {
    $commands.Add([ordered]@{ cmdlet = $spec.Cmdlet; parameters = $parameters })
    return @{ ok = $true; result = [ordered]@{ dryRun = $true; commands = $commands } }
  }
  $cmdlet = $spec.Cmdlet
  for ($attempt = 1; ; $attempt++) {
    try {
      $items = @(& $cmdlet @parameters)
      $rows = Select-Kept $items $spec.Keep
      return @{ ok = $true; result = $rows }
    } catch {
      $message = $_.Exception.Message
      if ($attempt -eq 1 -and $message -match $SessionErrorPattern) {
        $script:Session = $null
        try { Connect-Tenant $request.tenant $commands } catch { return @{ ok = $false; error = (Get-Failure 'exo_connect_failed' $_.Exception.Message) } }
        continue
      }
      $code = if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $message -match "couldn't be found|not found") { 'exo_not_found' } else { 'exo_failed' }
      return @{ ok = $false; error = (Get-Failure $code $message) }
    }
  }
}
