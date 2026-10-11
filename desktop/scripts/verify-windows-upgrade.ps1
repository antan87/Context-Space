# Installs real release artifacts. Only run on a disposable GitHub Windows runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The installer upgrade check requires a disposable GitHub Windows runner.'
}

$desktopRoot = Split-Path $PSScriptRoot -Parent
$candidateInstaller = Join-Path $desktopRoot 'dist/ContextSpaceSetup.exe'
$expectedVersion = (Get-Content (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'contextspace-upgrade-check'
$installRoot = Join-Path $fixtureRoot 'Existing NexusFlow Install'
New-Item -ItemType Directory -Force $fixtureRoot | Out-Null

$oldInstaller = Join-Path $fixtureRoot 'NexusFlowSetup.exe'
$releaseUrl = 'https://github.com/antan87/Context-Space/releases/download/v2.9.0/NexusFlowSetup.exe'
Invoke-WebRequest $releaseUrl -OutFile $oldInstaller
Invoke-WebRequest "$releaseUrl.sha256" -OutFile "$oldInstaller.sha256"
$checksum = (Get-Content "$oldInstaller.sha256" -Raw).Trim().Split()[0]
if ($checksum -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash $oldInstaller -Algorithm SHA256).Hash -ne $checksum) {
    throw 'The published 2.9.0 installer checksum does not match.'
}

function Install-Silently([string]$Installer, [string[]]$InstallerArguments) {
    # These installers include the bundled assistant runtimes. The baseline alone
    # takes nearly three minutes on hosted runners; upgrading also uninstalls it.
    $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $Installer -ArgumentList $InstallerArguments -PassThru
    if (-not $process.WaitForExit(600000)) {
        Get-CimInstance Win32_Process |
            Where-Object { $_.ExecutablePath -like "$fixtureRoot*" -or $_.Name -match 'ContextSpace|NexusFlow|Uninstall' } |
            Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
            Format-List | Out-String | Write-Output
        & taskkill /PID $process.Id /T /F
        throw "Installer timed out: $Installer"
    }
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode): $Installer" }
    Write-Output "Installer completed in $([Math]::Round($elapsed.Elapsed.TotalSeconds)) seconds: $Installer"
}

function Get-ProductRegistrations {
    foreach ($root in @('HKCU:', 'HKLM:')) {
        foreach ($key in @('Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            Get-ItemProperty "$root\$key\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match '^(NexusFlow|ContextSpace)(\s|$)' }
        }
    }
}

if (@(Get-ProductRegistrations).Count -ne 0) { throw 'Runner already has a product installation; refusing to replace it.' }

# NSIS requires /D to be the last argument, with its path unquoted even with spaces.
Write-Output 'Installing the checksum-verified 2.9.0 baseline.'
Install-Silently $oldInstaller @('/S', "/D=$installRoot")
$oldExecutable = Join-Path $installRoot 'NexusFlow.exe'
if (-not (Test-Path $oldExecutable)) { throw '2.9.0 did not install at the requested path.' }
$oldRegistrations = @(Get-ProductRegistrations)
if ($oldRegistrations.Count -ne 1) { throw 'Expected one registered 2.9.0 installation.' }
$oldRegistryKey = $oldRegistrations[0].PSPath

& node (Join-Path $PSScriptRoot 'verify-installed-desktop.mjs') before $oldExecutable $fixtureRoot '2.9.0'
if ($LASTEXITCODE -ne 0) { throw 'Installed 2.9.0 acceptance failed.' }

# Deliberately omit /D: the candidate must discover and upgrade the old installation.
Write-Output 'Upgrading the existing installation with the candidate.'
Install-Silently $candidateInstaller @('/S')
$newExecutable = Join-Path $installRoot 'ContextSpace.exe'
if (-not (Test-Path $newExecutable)) { throw 'Upgrade did not retain the existing installation directory.' }
if (Test-Path $oldExecutable) { throw 'Upgrade left the obsolete NexusFlow executable behind.' }
$newRegistrations = @(Get-ProductRegistrations)
if ($newRegistrations.Count -ne 1 -or $newRegistrations[0].PSPath -ne $oldRegistryKey) {
    throw 'Upgrade created a second installation or changed its uninstall registration.'
}
if ($newRegistrations[0].DisplayVersion -ne $expectedVersion) { throw 'Installed version was not updated.' }

& node (Join-Path $PSScriptRoot 'verify-installed-desktop.mjs') after $newExecutable $fixtureRoot $expectedVersion
if ($LASTEXITCODE -ne 0) { throw 'Installed candidate acceptance failed.' }
Write-Output "Verified 2.9.0 -> ${expectedVersion}: one installation, retained directory/profile/cookie/workspace, and working bundled backend."
