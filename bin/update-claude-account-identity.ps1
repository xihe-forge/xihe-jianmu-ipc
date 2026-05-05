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

  [switch]$SyncOauthFromCredentials
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
  Set-Content -LiteralPath $tempPath -Value $json -NoNewline -Encoding UTF8
  Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Copy-JsonValue {
  param([Parameter(Mandatory = $true)]$Value)
  return ($Value | ConvertTo-Json -Depth 64 | ConvertFrom-Json)
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

if ($SyncOauthFromCredentials) {
  $credentialsOauthProperty = Get-OauthPropertyName -Credentials $credentials
  if ([string]::IsNullOrWhiteSpace($credentialsOauthProperty)) {
    throw "missing OAuth object in credentials"
  }
  $vaultOauthProperty = Get-OauthPropertyName -Credentials $vault
  if ([string]::IsNullOrWhiteSpace($vaultOauthProperty)) {
    $vaultOauthProperty = $credentialsOauthProperty
  }
  $oauthCopy = Copy-JsonValue -Value $oauth
  if ($vault.PSObject.Properties.Name -contains $vaultOauthProperty) {
    $vault.$vaultOauthProperty = $oauthCopy
  } else {
    $vault | Add-Member -MemberType NoteProperty -Name $vaultOauthProperty -Value $oauthCopy
  }
}

$fingerprint = Get-TokenFingerprint -Token ([string]$oauth.refreshToken)
if ([string]::IsNullOrWhiteSpace($fingerprint)) {
  throw "missing refreshToken in Account $Which credentials"
}

$capturedAt = (Get-Date).ToUniversalTime().ToString('o')
$identity = [pscustomobject]@{
  which = $Which
  captured_at = $capturedAt
}

if ($vault.PSObject.Properties.Name -contains 'xihe_identity') {
  $vault.xihe_identity = $identity
} else {
  $vault | Add-Member -MemberType NoteProperty -Name 'xihe_identity' -Value $identity
}
Set-JsonFile -Path $VaultPath -Value $vault

$marker = [pscustomobject]@{
  which = $Which
  fingerprint = $fingerprint
  captured_at = $capturedAt
}
Set-JsonFile -Path $MarkerPath -Value $marker
Write-Host "[OK] Account $Which marker wrote refresh-token fingerprint"
