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
  [string]$MarkerPath
)

$ErrorActionPreference = 'Stop'
$profileEndpoint = 'https://api.anthropic.com/api/oauth/profile'

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
  Set-Content -LiteralPath $Path -Value $json -NoNewline -Encoding UTF8
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

$vault = Get-Content -Raw -LiteralPath $VaultPath | ConvertFrom-Json
$credentials = Get-Content -Raw -LiteralPath $CredentialsPath | ConvertFrom-Json
$oauth = Get-OauthObject -Credentials $credentials
$accessToken = [string]$oauth.accessToken
if ([string]::IsNullOrWhiteSpace($accessToken)) {
  throw "missing accessToken in credentials"
}

$profile = $null
try {
  $headers = @{ Authorization = "Bearer $accessToken" }
  $profile = Invoke-RestMethod -Method Get -Uri $profileEndpoint -Headers $headers -TimeoutSec 8
} catch {
  Write-Warning "profile identity capture failed for account $Which; using existing vault identity or legacy fingerprint marker: $($_.Exception.Message)"
}

if ($null -ne $profile) {
  $userId = $null
  foreach ($candidate in @($profile.account.uuid, $profile.account.id, $profile.user_id, $profile.sub, $profile.id)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
      $userId = [string]$candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($userId)) {
    throw "profile response did not include account.uuid/user_id"
  }

  $email = if ($null -ne $profile.account.email) { [string]$profile.account.email } elseif ($null -ne $profile.email) { [string]$profile.email } else { $null }
  $orgId = if ($null -ne $profile.organization.uuid) { [string]$profile.organization.uuid } elseif ($null -ne $profile.organization_id) { [string]$profile.organization_id } else { $null }
  $capturedAt = (Get-Date).ToUniversalTime().ToString('o')

  $identity = [pscustomobject]@{
    user_id = $userId
    email = $email
    org_id = $orgId
    captured_at = $capturedAt
    account_label = $Which
  }

  if ($vault.PSObject.Properties.Name -contains 'xihe_identity') {
    $vault.xihe_identity = $identity
  } else {
    $vault | Add-Member -MemberType NoteProperty -Name 'xihe_identity' -Value $identity
  }
  Set-JsonFile -Path $VaultPath -Value $vault

  $marker = [pscustomobject]@{
    which = $Which
    user_id = $userId
    captured_at = $capturedAt
  }
  Set-JsonFile -Path $MarkerPath -Value $marker

  Write-Host "[OK] Account $Which identity captured: user_id=$userId"
} elseif ($null -ne $vault.xihe_identity -and -not [string]::IsNullOrWhiteSpace([string]$vault.xihe_identity.user_id)) {
  $marker = [pscustomobject]@{
    which = $Which
    user_id = [string]$vault.xihe_identity.user_id
    captured_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  Set-JsonFile -Path $MarkerPath -Value $marker
  Write-Host "[OK] Account $Which marker restored from existing vault identity"
} else {
  $fingerprint = Get-TokenFingerprint -Token ([string]$oauth.refreshToken)
  if ([string]::IsNullOrWhiteSpace($fingerprint)) {
    throw "missing refreshToken in Account $Which vault and no identity fallback exists"
  }
  $marker = [pscustomobject]@{
    which = $Which
    fingerprint = $fingerprint
  }
  Set-JsonFile -Path $MarkerPath -Value $marker
  Write-Host "[OK] Account $Which marker wrote legacy fingerprint fallback"
}
