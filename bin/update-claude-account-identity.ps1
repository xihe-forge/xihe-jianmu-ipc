#requires -version 5
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('a', 'b')]
  [string]$Which,

  [Parameter(Mandatory = $true)]
  [string]$VaultPath,

  [Parameter(Mandatory = $true)]
  [string]$CredentialsPath,

  [Parameter(Mandatory = $true)]
  [string]$MarkerPath,

  [switch]$SyncOauthFromCredentials,

  [string]$ProfileEndpoint = 'https://api.anthropic.com/api/oauth/profile'
)

$ErrorActionPreference = 'Stop'

function Get-OauthPropertyName {
  param([Parameter(Mandatory = $true)]$Credentials)
  foreach ($name in @('claudeAiOauth', 'claude_ai_oauth', 'oauth')) {
    if ($null -ne $Credentials.PSObject.Properties[$name]) { return $name }
  }
  return $null
}

function Get-OauthObject {
  param([Parameter(Mandatory = $true)]$Credentials)
  if ($null -ne $Credentials.claudeAiOauth) { return $Credentials.claudeAiOauth }
  if ($null -ne $Credentials.claude_ai_oauth) { return $Credentials.claude_ai_oauth }
  if ($null -ne $Credentials.oauth) { return $Credentials.oauth }
  return $null
}

function Set-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 64
  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $tempPath = "$Path.tmp.$PID.$([Guid]::NewGuid().ToString('n'))"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
  Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Copy-JsonValue {
  param([Parameter(Mandatory = $true)]$Value)
  return ($Value | ConvertTo-Json -Depth 64 | ConvertFrom-Json)
}

function Preserve-NonEmptyOauthField {
  param(
    [Parameter(Mandatory = $true)]$Target,
    $Source,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Source) { return }
  $incoming = if ($null -ne $Target.PSObject.Properties[$Name]) { [string]$Target.$Name } else { $null }
  $existing = if ($null -ne $Source.PSObject.Properties[$Name]) { [string]$Source.$Name } else { $null }
  if ([string]::IsNullOrWhiteSpace($incoming) -and -not [string]::IsNullOrWhiteSpace($existing)) {
    if ($null -ne $Target.PSObject.Properties[$Name]) {
      $Target.$Name = $existing
    } else {
      $Target | Add-Member -MemberType NoteProperty -Name $Name -Value $existing
    }
  }
}

function Get-TokenFingerprint {
  param([string]$Token)
  if ([string]::IsNullOrWhiteSpace($Token)) { return $null }
  $tail = $Token.Substring([Math]::Max(0, $Token.Length - 16))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tail))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
}

function Get-ProfileIdentity {
  param($Profile)

  if ($null -eq $Profile) { return $null }
  $userId = $null
  foreach ($candidate in @($Profile.account.uuid, $Profile.account.id, $Profile.user_id, $Profile.sub, $Profile.id)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
      $userId = [string]$candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($userId)) { return $null }

  $email = if ($null -ne $Profile.account.email) { [string]$Profile.account.email } elseif ($null -ne $Profile.email) { [string]$Profile.email } else { $null }
  $orgId = if ($null -ne $Profile.organization.uuid) { [string]$Profile.organization.uuid } elseif ($null -ne $Profile.organization.id) { [string]$Profile.organization.id } elseif ($null -ne $Profile.org_id) { [string]$Profile.org_id } elseif ($null -ne $Profile.organization_id) { [string]$Profile.organization_id } else { $null }

  return [pscustomobject]@{
    user_id = [string]$userId
    email = $email
    org_id = $orgId
  }
}

function Set-VaultIdentity {
  param(
    [Parameter(Mandatory = $true)]$Vault,
    [Parameter(Mandatory = $true)]$Identity
  )

  if ($Vault.PSObject.Properties.Name -contains 'xihe_identity') {
    $Vault.xihe_identity = $Identity
  } else {
    $Vault | Add-Member -MemberType NoteProperty -Name 'xihe_identity' -Value $Identity
  }
}

function New-Marker {
  param(
    [Parameter(Mandatory = $true)][string]$Which,
    [string]$Fingerprint,
    [string]$UserId,
    [Parameter(Mandatory = $true)][string]$CapturedAt
  )

  $marker = [ordered]@{
    which = $Which
  }
  if (-not [string]::IsNullOrWhiteSpace($Fingerprint)) {
    $marker.fingerprint = $Fingerprint
  }
  if (-not [string]::IsNullOrWhiteSpace($UserId)) {
    $marker.user_id = $UserId
  }
  $marker.captured_at = $CapturedAt
  return [pscustomobject]$marker
}

$vault = Get-Content -Raw -LiteralPath $VaultPath | ConvertFrom-Json
$credentials = Get-Content -Raw -LiteralPath $CredentialsPath | ConvertFrom-Json
$oauth = Get-OauthObject -Credentials $credentials

if ($SyncOauthFromCredentials) {
  $credentialsOauthProperty = Get-OauthPropertyName -Credentials $credentials
  if ([string]::IsNullOrWhiteSpace($credentialsOauthProperty)) {
    throw "missing OAuth object in credentials"
  }
  $vaultOauthProperty = Get-OauthPropertyName -Credentials $vault
  if ([string]::IsNullOrWhiteSpace($vaultOauthProperty)) {
    $vaultOauthProperty = $credentialsOauthProperty
  }
  $vaultOauthBefore = Get-OauthObject -Credentials $vault
  $oauthCopy = Copy-JsonValue -Value $oauth
  foreach ($field in @('accessToken', 'refreshToken', 'access_token', 'refresh_token')) {
    Preserve-NonEmptyOauthField -Target $oauthCopy -Source $vaultOauthBefore -Name $field
  }
  if ($vault.PSObject.Properties.Name -contains $vaultOauthProperty) {
    $vault.$vaultOauthProperty = $oauthCopy
  } else {
    $vault | Add-Member -MemberType NoteProperty -Name $vaultOauthProperty -Value $oauthCopy
  }
}

$fingerprint = Get-TokenFingerprint -Token ([string]$oauth.refreshToken)
if ([string]::IsNullOrWhiteSpace($fingerprint)) {
  $vaultOauthForFallback = Get-OauthObject -Credentials $vault
  $fingerprint = Get-TokenFingerprint -Token ([string]$vaultOauthForFallback.refreshToken)
}
$capturedAt = (Get-Date).ToUniversalTime().ToString('o')
$existingUserId = if ($null -ne $vault.xihe_identity -and -not [string]::IsNullOrWhiteSpace([string]$vault.xihe_identity.user_id)) { [string]$vault.xihe_identity.user_id } else { $null }
$profileIdentity = $null

if (-not ($SyncOauthFromCredentials -and -not [string]::IsNullOrWhiteSpace($existingUserId))) {
  $accessToken = [string]$oauth.accessToken
  if (-not [string]::IsNullOrWhiteSpace($accessToken)) {
    try {
      $headers = @{ Authorization = "Bearer $accessToken" }
      $profile = Invoke-RestMethod -Method Get -Uri $ProfileEndpoint -Headers $headers -TimeoutSec 8
      $profileIdentity = Get-ProfileIdentity -Profile $profile
      if ($null -eq $profileIdentity) {
        Write-Warning "profile identity capture returned no user_id for account $Which; using existing vault identity or fingerprint fallback"
      }
    } catch {
      Write-Warning "profile identity capture failed for account $Which; using existing vault identity or fingerprint fallback: $($_.Exception.Message)"
    }
  }
}

if ($null -ne $profileIdentity -and -not [string]::IsNullOrWhiteSpace([string]$profileIdentity.user_id)) {
  $identity = [pscustomobject]@{
    user_id = [string]$profileIdentity.user_id
    email = $profileIdentity.email
    org_id = $profileIdentity.org_id
    captured_at = $capturedAt
    account_label = $Which
    which = $Which
  }
  Set-VaultIdentity -Vault $vault -Identity $identity
  Set-JsonFile -Path $VaultPath -Value $vault

  $marker = New-Marker -Which $Which -Fingerprint $fingerprint -UserId ([string]$profileIdentity.user_id) -CapturedAt $capturedAt
  Set-JsonFile -Path $MarkerPath -Value $marker
  Write-Host "[OK] Account $Which identity captured: user_id=$($profileIdentity.user_id)"
} elseif (-not [string]::IsNullOrWhiteSpace($existingUserId)) {
  Set-JsonFile -Path $VaultPath -Value $vault
  $marker = New-Marker -Which $Which -Fingerprint $fingerprint -UserId $existingUserId -CapturedAt $capturedAt
  Set-JsonFile -Path $MarkerPath -Value $marker
  Write-Host "[OK] Account $Which marker restored from existing vault identity"
} else {
  if ([string]::IsNullOrWhiteSpace($fingerprint)) {
    throw "missing refreshToken in Account $Which credentials and no user_id fallback exists"
  }
  $identity = [pscustomobject]@{
    which = $Which
    captured_at = $capturedAt
  }
  Set-VaultIdentity -Vault $vault -Identity $identity
  Set-JsonFile -Path $VaultPath -Value $vault

  $marker = New-Marker -Which $Which -Fingerprint $fingerprint -CapturedAt $capturedAt
  Set-JsonFile -Path $MarkerPath -Value $marker
  Write-Host "[OK] Account $Which marker wrote refresh-token fingerprint fallback"
}
