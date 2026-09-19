param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{40}$')]
  [string]$ExpectedThumbprint,

  [string]$TimestampUrl,

  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$expected = $ExpectedThumbprint.ToUpperInvariant()

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $tool = Get-ChildItem -LiteralPath $kits -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $tool) {
    throw 'Windows SDK signtool.exe was not found'
  }
  return $tool.FullName
}

$signTool = Find-SignTool
if (-not $VerifyOnly) {
  $timestamp = $null
  if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestamp) -or
      $timestamp.Scheme -notin @('http', 'https') -or
      -not [string]::IsNullOrEmpty($timestamp.UserInfo)) {
    throw 'The Authenticode timestamp URL must be an HTTP(S) URL without credentials'
  }

  & $signTool sign /sha1 $expected /fd SHA256 /tr $TimestampUrl /td SHA256 /v $resolvedPath
  if ($LASTEXITCODE -ne 0) {
    throw "Authenticode signing failed: $resolvedPath"
  }
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "The file does not have a valid Authenticode signature: $resolvedPath ($($signature.Status))"
}
if ($signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $expected) {
  throw "The file was not signed by the expected release certificate: $resolvedPath"
}
if (-not $signature.TimeStamperCertificate) {
  throw "The file does not have an Authenticode timestamp: $resolvedPath"
}

& $signTool verify /pa /all /v $resolvedPath
if ($LASTEXITCODE -ne 0) {
  throw "Authenticode trust verification failed: $resolvedPath"
}

Write-Output "Authenticode verification passed: $resolvedPath"
