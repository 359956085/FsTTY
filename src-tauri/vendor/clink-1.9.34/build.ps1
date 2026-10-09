param([Parameter(Mandatory)][string]$Premake, [Parameter(Mandatory)][string]$MSBuild,
      [string]$Output = (Join-Path $PSScriptRoot 'rebuild'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Output -Force | Out-Null
Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'source.zip') -DestinationPath $Output
$source = Join-Path $Output 'clink-1.9.34'
Push-Location $source
try {
    git apply --unsafe-paths (Join-Path $PSScriptRoot 'isolation.patch')
    if ($LASTEXITCODE -ne 0) { throw 'Isolation patch failed' }
    & $Premake --file=premake5.lua vs2022
    if ($LASTEXITCODE -ne 0) { throw 'Premake failed' }
    & $MSBuild .build/vs2022/clink.sln /m:4 /p:Configuration=final /p:Platform=x64 /t:clink_app_dll,clink_app_exe
    if ($LASTEXITCODE -ne 0) { throw 'Clink build failed' }
} finally { Pop-Location }
