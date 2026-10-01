$ErrorActionPreference = "Stop"
$releaseDir = Join-Path $PWD "packages/desktop/release"
$installer = Get-ChildItem -LiteralPath $releaseDir -Filter "*.exe" | Where-Object { $_.Name -notlike "*uninstaller*" } | Select-Object -First 1
if ($null -eq $installer) { throw "NSIS installer not found in $releaseDir" }

$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$installDir = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp ("pi-orbit-installed-" + [guid]::NewGuid().ToString("N"))))
if (-not $installDir.StartsWith($runnerTemp.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Install directory must stay within RUNNER_TEMP"
}
try {
    Start-Process -FilePath $installer.FullName -ArgumentList "/S", "/D=$installDir" -WindowStyle Hidden -Wait
    $appPath = Join-Path $installDir "Pi Orbit.exe"
    if (-not (Test-Path -LiteralPath $appPath)) { throw "Installed app not found: $appPath" }

    node test/smoke/desktop-api-smoke.mjs $appPath
    if ($LASTEXITCODE -ne 0) { throw "Installed application API smoke failed with exit code $LASTEXITCODE" }
} finally {
    $uninstaller = Join-Path $installDir "Uninstall Pi Orbit.exe"
    if (Test-Path -LiteralPath $installDir) {
        if (-not (Test-Path -LiteralPath $uninstaller)) { throw "NSIS uninstaller not found: $uninstaller" }
        Start-Process -FilePath $uninstaller -ArgumentList "/S" -WindowStyle Hidden -Wait
        if (Test-Path -LiteralPath $installDir) { throw "Silent uninstall left the installation directory in place" }
    }
}
