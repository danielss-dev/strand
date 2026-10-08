# Windows MSI taskbar-pin upgrade rehearsal (DAN-81 / #135).
#
# A GitHub Actions windows-latest runner has no interactive Explorer/taskbar.
# This script proves shortcut IconLocation + file existence across msiexec
# major upgrades. It cannot prove that Explorer's live taskbar bitmap updates.
param(
    [Parameter(Mandatory = $true)][string]$Msi172,
    [Parameter(Mandatory = $true)][string]$Msi173,
    [Parameter(Mandatory = $true)][string]$Msi174,
    [string]$LogPath = 'msi-pin-rehearsal.log'
)

$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$logLines = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format 'o')  $Message"
    $logLines.Add($line)
    Write-Host $line
}

function Export-MsiShortcuts([string]$MsiPath, [string]$Label) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase((Resolve-Path -LiteralPath $MsiPath).Path, 0)
    Write-Log "MSI $Label ($([IO.Path]::GetFileName($MsiPath)))"
    $view = $database.OpenView('SELECT `Shortcut`, `Target`, `Icon_`, `IconIndex` FROM `Shortcut`')
    try {
        $view.Execute()
        while ($record = $view.Fetch()) {
            Write-Log ("  Shortcut {0}: Target={1} Icon_={2} IconIndex={3}" -f `
                $record.StringData(1), $record.StringData(2), $record.StringData(3), $record.StringData(4))
        }
    } finally {
        $view.Close()
    }
    $view = $database.OpenView('SELECT `Shortcut_`, `PropertyKey`, `PropVariantValue` FROM `MsiShortcutProperty`')
    try {
        $view.Execute()
        while ($record = $view.Fetch()) {
            Write-Log ("  Property {0}: {1}={2}" -f `
                $record.StringData(1), $record.StringData(2), $record.StringData(3))
        }
    } finally {
        $view.Close()
    }
}

function Get-LnkDump([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            Path = $Path
            Exists = $false
        }
    }
    $lnk = $shell.CreateShortcut($Path)
    $iconLocation = [string]$lnk.IconLocation
    $iconPath = $iconLocation
    $iconIndex = ''
    if ($iconLocation -match '^(.*),(-?\d+)$') {
        $iconPath = $Matches[1].Trim().Trim('"')
        $iconIndex = $Matches[2]
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $utf16 = [Text.Encoding]::Unicode.GetString($bytes)
    $iconExists = if ([string]::IsNullOrWhiteSpace($iconPath)) { $null } else { Test-Path -LiteralPath $iconPath }
    [pscustomobject]@{
        Path = $Path
        Exists = $true
        TargetPath = [string]$lnk.TargetPath
        IconLocation = $iconLocation
        IconPath = $iconPath
        IconIndex = $iconIndex
        IconFileExists = $iconExists
        TargetExists = Test-Path -LiteralPath ([string]$lnk.TargetPath)
        HasAumid = $utf16.Contains('dev.danielss.strand')
        WorkingDirectory = [string]$lnk.WorkingDirectory
    }
}

function Write-LnkDump([string]$Label, [string]$Path) {
    $dump = Get-LnkDump $Path
    if (!$dump.Exists) {
        Write-Log "  $Label MISSING $Path"
        return $dump
    }
    Write-Log ("  {0}: Target={1} (exists={2}) IconLocation={3} iconFileExists={4} AUMID={5}" -f `
        $Label, $dump.TargetPath, $dump.TargetExists, $dump.IconLocation, $dump.IconFileExists, $dump.HasAumid)
    return $dump
}

function Install-Msi([string]$MsiPath, [string]$Label) {
    $log = Join-Path ([IO.Path]::GetTempPath()) "strand-$Label.log"
    Write-Log "msiexec /i $Label"
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @(
        '/i', (Resolve-Path -LiteralPath $MsiPath).Path,
        '/qn', '/norestart',
        '/l*v', $log
    ) -Wait -PassThru
    if ($process.ExitCode -notin 0, 1641, 3010) {
        if (Test-Path -LiteralPath $log) {
            Write-Log ((Get-Content -LiteralPath $log -Tail 40) -join "`n")
        }
        throw "msiexec /i $Label failed with exit $($process.ExitCode)"
    }
    Write-Log "msiexec /i $Label exit=$($process.ExitCode)"
}

function Find-StrandShortcut([string]$Root, [string]$NameHint) {
    if (!(Test-Path -LiteralPath $Root)) { return $null }
    Get-ChildItem -LiteralPath $Root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -like '*Strand*' -and $_.BaseName -notlike '*Uninstall*' } |
        Select-Object -First 1 -ExpandProperty FullName
}

function New-PinCopy([string]$Source, [string]$Destination) {
    $dir = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function New-RunningWindowPin([string]$Source, [string]$Destination, [string]$Exe) {
    $dir = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $src = $shell.CreateShortcut($Source)
    $lnk = $shell.CreateShortcut($Destination)
    $lnk.TargetPath = $Exe
    $lnk.WorkingDirectory = Split-Path -Parent $Exe
    $lnk.WindowStyle = 1
    $lnk.Description = 'Runs Strand'
    # Explorer copies the Start Menu icon when pinning a running app by AUMID.
    $lnk.IconLocation = $src.IconLocation
    $lnk.Save()
}

Export-MsiShortcuts $Msi172 '1.7.2'
Export-MsiShortcuts $Msi173 '1.7.3'
Export-MsiShortcuts $Msi174 '1.7.4'

Install-Msi $Msi172 '1.7.2'

$exe = 'C:\Program Files\Strand\strand.exe'
if (!(Test-Path -LiteralPath $exe)) { throw "strand.exe missing after 1.7.2 install: $exe" }
Write-Log "Installed exe exists=$true path=$exe"

$startMenu = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk",
    "$env:AppData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$startMenu) {
    $startMenu = Find-StrandShortcut "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" 'Strand'
}
if (!$startMenu) {
    $startMenu = Find-StrandShortcut "$env:AppData\Microsoft\Windows\Start Menu\Programs" 'Strand'
}
if (!$startMenu) { throw 'Start Menu Strand.lnk not found after 1.7.2 install' }

$desktop = @(
    "$env:Public\Desktop\Strand.lnk",
    "$env:UserProfile\Desktop\Strand.lnk"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

Write-Log 'After 1.7.2 install (before pins)'
$null = Write-LnkDump 'start-menu' $startMenu
if ($desktop) { $null = Write-LnkDump 'desktop' $desktop }

$pinDir = Join-Path $env:AppData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$pinFromStart = Join-Path $pinDir 'Strand-from-start.lnk'
$pinFromRunning = Join-Path $pinDir 'Strand-from-running.lnk'
New-PinCopy $startMenu $pinFromStart
New-RunningWindowPin $startMenu $pinFromRunning $exe

Write-Log 'After creating 1.7.2-era pins'
$startPin172 = Write-LnkDump 'pin-from-start' $pinFromStart
$runningPin172 = Write-LnkDump 'pin-from-running' $pinFromRunning
$installerIcon172 = $startPin172.IconPath

Install-Msi $Msi173 '1.7.3'

Write-Log 'After upgrade 1.7.2 -> 1.7.3'
$startMenu173 = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk",
    "$env:AppData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$startMenu173) { $startMenu173 = $startMenu }
$null = Write-LnkDump 'start-menu' $startMenu173
$startPinAfter173 = Write-LnkDump 'pin-from-start' $pinFromStart
$runningPinAfter173 = Write-LnkDump 'pin-from-running' $pinFromRunning
if ($installerIcon172) {
    Write-Log ("  1.7.2 ProductIcon still exists after 1.7.3? {0}" -f (Test-Path -LiteralPath $installerIcon172))
}

$pinFromStart173 = Join-Path $pinDir 'Strand-from-start-1.7.3.lnk'
$pinFromRunning173 = Join-Path $pinDir 'Strand-from-running-1.7.3.lnk'
New-PinCopy $startMenu173 $pinFromStart173
New-RunningWindowPin $startMenu173 $pinFromRunning173 $exe
Write-Log 'Created 1.7.3-era pins from the rewritten Start Menu shortcut'
$null = Write-LnkDump 'pin-from-start-1.7.3' $pinFromStart173
$null = Write-LnkDump 'pin-from-running-1.7.3' $pinFromRunning173

Install-Msi $Msi174 '1.7.4'

Write-Log 'After upgrade 1.7.3 -> 1.7.4'
$startMenu174 = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk",
    "$env:AppData\Microsoft\Windows\Start Menu\Programs\Strand\Strand.lnk"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$startMenu174) { $startMenu174 = $startMenu173 }
$null = Write-LnkDump 'start-menu' $startMenu174
$startPinAfter174 = Write-LnkDump 'pin-from-start' $pinFromStart
$runningPinAfter174 = Write-LnkDump 'pin-from-running' $pinFromRunning
$startPin173After174 = Write-LnkDump 'pin-from-start-1.7.3' $pinFromStart173
$runningPin173After174 = Write-LnkDump 'pin-from-running-1.7.3' $pinFromRunning173
if ($installerIcon172) {
    Write-Log ("  1.7.2 ProductIcon still exists after 1.7.4? {0}" -f (Test-Path -LiteralPath $installerIcon172))
}

$failures = New-Object System.Collections.Generic.List[string]

function Assert-StaleProductIconPin($Dump, [string]$Name) {
    $staleCache = $Dump.IconPath -like '*\Installer\*' -and $Dump.IconFileExists -eq $false
    if ($staleCache) {
        Write-Log "CONFIRMED: $Name IconLocation still points at a missing Installer ProductIcon ($($Dump.IconLocation))."
        return
    }
    $failures.Add("$Name expected a stale Installer ProductIcon after upgrade; got IconLocation=$($Dump.IconLocation) exists=$($Dump.IconFileExists)")
}

function Assert-HealthyPin($Dump, [string]$Name) {
    $usesInstaller = $Dump.IconPath -like '*\Installer\*'
    $iconOk = [string]::IsNullOrWhiteSpace($Dump.IconPath) -or ($Dump.IconFileExists -eq $true)
    if ($usesInstaller -or !$Dump.TargetExists -or !$iconOk) {
        $failures.Add("$Name is not a durable post-1.7.3 pin: IconLocation=$($Dump.IconLocation) iconExists=$($Dump.IconFileExists)")
    } else {
        Write-Log "CONFIRMED: $Name survived with a valid icon reference ($($Dump.IconLocation))."
    }
}

Assert-StaleProductIconPin $startPinAfter173 '1.7.2 start pin after 1.7.3'
Assert-StaleProductIconPin $runningPinAfter173 '1.7.2 running-window pin after 1.7.3'
Assert-StaleProductIconPin $startPinAfter174 '1.7.2 start pin after 1.7.4'
Assert-StaleProductIconPin $runningPinAfter174 '1.7.2 running-window pin after 1.7.4'

Assert-HealthyPin $startPin173After174 '1.7.3 start pin after 1.7.4'
Assert-HealthyPin $runningPin173After174 '1.7.3 running-window pin after 1.7.4'

Write-Log 'CI runner limits: no interactive desktop, no live taskbar bitmap, no HWND-pin from a visible Strand window. Pins are .lnk files in User Pinned\TaskBar with IconLocation copied the way Explorer copies the Start Menu shortcut when pinning by AppUserModelID.'

$logLines | Set-Content -LiteralPath $LogPath -Encoding utf8
if ($failures.Count) {
    Write-Log ("Rehearsal FAILED:`n - " + ($failures -join "`n - "))
    throw "MSI pin rehearsal failed with $($failures.Count) check(s)."
}
Write-Log "Rehearsal log written to $LogPath"
Write-Log 'Rehearsal PASSED'
