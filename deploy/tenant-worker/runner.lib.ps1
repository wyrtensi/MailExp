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
# An address: the panel's local part (letters, digits, dot, dash, underscore, no '..') and a domain.
$AddressPattern = '^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@(?=.{1,253}\z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\z'
# Stage 7c: a quarantined message's Identity (GUID1\GUID2) and a page number (1 to 1000) as digits.
$QuarantineIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
$PagePattern = '^(?:[1-9][0-9]{0,2}|1000)\z'
# What an EXO error says when the session itself is gone (an expired token, a dropped connection),
# as opposed to the operation failing: then the runner connects again once and repeats the
# operation. A write repeated so may find its object made already (exo_exists), which the panel
# reads as done after reading it back.
# Word-bounded, so "connector" in an error of Get-BlockedConnector is not a session error.
$SessionErrorPattern = '\bsession\b|\btoken\b|\bnot connected\b|\bconnection\b|\bunauthori[sz]ed\b|\b401\b'
# A write that finds its object made already (repeated after a reconnect, or two syncs at once):
# the panel reads again instead of failing. EXO throttling: the panel waits and tries again later.
# Checked after "not found" and the session errors, in this order.
$ThrottledPattern = 'throttl|micro delay|server ?busy|exceeded the budget|too many concurrent'
$ExistsPattern = 'already exists|already being used|is already used|already present'

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
  # Stage 7b. Args: argument -> @(parameter or parameters, pattern[, 'add']); 'add' passes the value
  # as @{ Add = <value> } (a multi-valued property gains one value, the others stay).
  # R-24 and R-29: the accepted domain's type.
  set_accepted_domain_internal_relay = @{
    Cmdlet = 'Set-AcceptedDomain'; Fixed = @{ DomainType = 'InternalRelay' }; Args = @{ domain = @('Identity', $DomainPattern) }
    Keep = @()
  }
  set_accepted_domain_authoritative = @{
    Cmdlet = 'Set-AcceptedDomain'; Fixed = @{ DomainType = 'Authoritative' }; Args = @{ domain = @('Identity', $DomainPattern) }
    Keep = @()
  }
  # R-25: the connectors as the reference and the comparison read them, and a domain added to the
  # Outbound connector's RecipientDomains.
  get_inbound_connectors = @{
    Cmdlet = 'Get-InboundConnector'; Fixed = @{}; Args = @{}
    Keep = @('Identity', 'Name', 'Enabled', 'ConnectorType', 'ConnectorSource', 'SenderDomains', 'SenderIPAddresses',
      'RequireTls', 'RestrictDomainsToCertificate', 'RestrictDomainsToIPAddresses', 'TlsSenderCertificateName',
      'CloudServicesMailEnabled', 'TreatMessagesAsInternal', 'WhenChanged')
  }
  get_outbound_connectors = @{
    Cmdlet = 'Get-OutboundConnector'; Fixed = @{}; Args = @{}
    Keep = @('Identity', 'Name', 'Enabled', 'ConnectorType', 'ConnectorSource', 'RecipientDomains', 'SmartHosts', 'UseMXRecord',
      'TlsSettings', 'TlsDomain', 'AllAcceptedDomains', 'IsTransportRuleScoped', 'CloudServicesMailEnabled', 'IsValidated',
      'LastValidationTimestamp', 'WhenChanged', 'Guid')
  }
  add_outbound_connector_domain = @{
    Cmdlet = 'Set-OutboundConnector'; Fixed = @{}
    Args = @{ connector = @('Identity', $GuidPattern); domain = @('RecipientDomains', $DomainPattern, 'add') }
    Keep = @()
  }
  # R-26: the EOP DKIM signing config of a domain, made disabled, read, then enabled.
  new_dkim_signing_config = @{
    Cmdlet = 'New-DkimSigningConfig'; Fixed = @{ Enabled = $false; KeySize = 2048 }; Args = @{ domain = @('DomainName', $DomainPattern) }
    Keep = @('Identity', 'Domain', 'Enabled', 'Status', 'Selector1CNAME', 'Selector2CNAME')
  }
  get_dkim_signing_config = @{
    Cmdlet = 'Get-DkimSigningConfig'; Fixed = @{}; Args = @{ domain = @('Identity', $DomainPattern) }
    Keep = @('Identity', 'Domain', 'Enabled', 'Status', 'Selector1CNAME', 'Selector2CNAME')
  }
  enable_dkim_signing_config = @{
    Cmdlet = 'Set-DkimSigningConfig'; Fixed = @{ Enabled = $true }; Args = @{ domain = @('Identity', $DomainPattern) }
    Keep = @()
  }
  # R-29: the recipient mirror. The contact's name is its address (unique in the tenant).
  get_recipients = @{
    Cmdlet = 'Get-Recipient'; Fixed = @{ ResultSize = 'Unlimited' }; Args = @{}
    Keep = @('Identity', 'Name', 'PrimarySmtpAddress', 'ExternalEmailAddress', 'EmailAddresses', 'RecipientTypeDetails',
      'HiddenFromAddressListsEnabled')
  }
  new_mail_contact = @{
    Cmdlet = 'New-MailContact'; Fixed = @{}
    Args = @{ address = @(@('Name', 'PrimarySmtpAddress'), $AddressPattern); external = @('ExternalEmailAddress', $AddressPattern) }
    Keep = @('Identity', 'Name', 'PrimarySmtpAddress', 'ExternalEmailAddress')
  }
  # D-7: a contact moved to the other variant in place, never removed and made again.
  set_mail_contact_external = @{
    Cmdlet = 'Set-MailContact'; Fixed = @{}
    Args = @{ address = @('Identity', $AddressPattern); external = @('ExternalEmailAddress', $AddressPattern) }
    Keep = @()
  }
  hide_mail_contact = @{
    Cmdlet = 'Set-MailContact'; Fixed = @{ HiddenFromAddressListsEnabled = $true }; Args = @{ address = @('Identity', $AddressPattern) }
    Keep = @()
  }
  remove_mail_contact = @{
    Cmdlet = 'Remove-MailContact'; Fixed = @{ Confirm = $false }; Args = @{ address = @('Identity', $AddressPattern) }
    Keep = @()
  }
  # Stage 7c, R-42 (D-2): inbound high confidence phishing not yet released, a page at a time; one
  # message by its Identity (its recipients are shown only then); released to all its recipients.
  get_quarantine_messages = @{
    Cmdlet = 'Get-QuarantineMessage'
    Fixed = @{ QuarantineTypes = 'HighConfPhish'; Direction = 'Inbound'; ReleaseStatus = 'NotReleased'; PageSize = 100 }
    Args = @{ page = @('Page', $PagePattern) }
    Keep = @('Identity', 'ReceivedTime', 'SenderAddress', 'Subject', 'Type', 'QuarantineTypes', 'ReleaseStatus', 'Direction',
      'MessageId', 'Expires', 'RecipientCount')
  }
  get_quarantine_message = @{
    Cmdlet = 'Get-QuarantineMessage'; Fixed = @{}; Args = @{ identity = @('Identity', $QuarantineIdPattern) }
    Keep = @('Identity', 'ReceivedTime', 'SenderAddress', 'RecipientAddress', 'Subject', 'Type', 'QuarantineTypes', 'ReleaseStatus',
      'Released', 'ReleasedUser', 'Direction', 'MessageId', 'Expires')
  }
  release_quarantine_message = @{
    Cmdlet = 'Release-QuarantineMessage'; Fixed = @{ ReleaseToAll = $true; Confirm = $false }
    Args = @{ identity = @('Identity', $QuarantineIdPattern) }
    Keep = @()
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
    $shaped = if ($entry.Value.Count -gt 2 -and $entry.Value[2] -eq 'add') { @{ Add = $value } } else { $value }
    foreach ($name in @($entry.Value[0])) { $parameters[$name] = $shaped }
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
      $code = if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $message -match "couldn't be found|not found") { 'exo_not_found' }
        elseif ($message -match $ThrottledPattern) { 'exo_throttled' }
        elseif ($message -match $ExistsPattern) { 'exo_exists' }
        else { 'exo_failed' }
      return @{ ok = $false; error = (Get-Failure $code $message) }
    }
  }
}
