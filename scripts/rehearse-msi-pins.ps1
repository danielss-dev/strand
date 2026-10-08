# Windows MSI taskbar-pin upgrade rehearsal (DAN-81 / #135).
#
# A GitHub Actions windows-latest runner has no interactive Explorer/taskbar.
# This script proves shortcut IconLocation + file existence across msiexec
# major upgrades, then runs this PR's `heal_pins_in` against the real User
# Pinned directory. It cannot prove that Explorer's live taskbar bitmap updates.
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

function Get-LnkFingerprint([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            Path = $Path
            Exists = $false
        }
    }
    $item = Get-Item -LiteralPath $Path
    [pscustomobject]@{
        Path = $Path
        Exists = $true
        Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        CreationTimeUtc = $item.CreationTimeUtc.ToString('o')
        LastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
        Length = $item.Length
    }
}

function Write-LnkFingerprint([string]$Label, $Fingerprint) {
    if (!$Fingerprint.Exists) {
        Write-Log "  $Label fingerprint MISSING $($Fingerprint.Path)"
        return
    }
    Write-Log ("  {0} fingerprint: sha256={1} created={2} written={3} length={4}" -f `
        $Label, $Fingerprint.Sha256, $Fingerprint.CreationTimeUtc, $Fingerprint.LastWriteTimeUtc, $Fingerprint.Length)
}

function New-UnrelatedPin([string]$Destination) {
    $dir = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $notepad = Join-Path $env:SystemRoot 'System32\notepad.exe'
    if (!(Test-Path -LiteralPath $notepad)) {
        throw "notepad.exe missing: $notepad"
    }
    $lnk = $shell.CreateShortcut($Destination)
    $lnk.TargetPath = $notepad
    $lnk.WorkingDirectory = Split-Path -Parent $notepad
    $lnk.WindowStyle = 1
    $lnk.Description = 'Unrelated non-Strand pin'
    # Stale installer-cache icon on a non-Strand target: heal must leave this alone.
    $lnk.IconLocation = 'C:\Windows\Installer\{DEADBEEF-0000-0000-0000-000000000000}\ProductIcon,0'
    $lnk.Save()
}

function Invoke-PinHeal([string]$PinnedRoot, [string]$InstalledExe) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    if (!(Test-Path -LiteralPath (Join-Path $repoRoot 'Cargo.toml'))) {
        throw "repo root not found from `$PSScriptRoot=$PSScriptRoot"
    }
    $env:STRAND_PIN_HEAL_DIR = $PinnedRoot
    $env:STRAND_PIN_HEAL_EXE = $InstalledExe
    Write-Log "STRAND_PIN_HEAL_DIR=$PinnedRoot"
    Write-Log "STRAND_PIN_HEAL_EXE=$InstalledExe"
    Write-Log 'cargo test -p strand-tauri heals_rehearsal_user_pinned_dir -- --ignored --nocapture'
    Push-Location $repoRoot
    try {
        $outputLines = & cargo test -p strand-tauri heals_rehearsal_user_pinned_dir -- --ignored --nocapture 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $healed = $null
    foreach ($line in $outputLines) {
        $text = [string]$line
        if ($text) { Write-Log "  cargo: $text" }
        if ($text -match 'STRAND_PIN_HEAL healed=(\d+)') {
            $healed = [int]$Matches[1]
        }
    }
    if ($code -ne 0) {
        throw "heal cargo test failed with exit $code"
    }
    if ($null -eq $healed) {
        throw 'heal cargo test did not print STRAND_PIN_HEAL healed='
    }
    return $healed
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

$unrelatedPin = Join-Path $pinDir 'Notepad-unrelated.lnk'
New-UnrelatedPin $unrelatedPin
Write-Log 'Created unrelated non-Strand pin (notepad + missing Installer ProductIcon)'
$unrelatedBefore = Write-LnkDump 'unrelated-notepad' $unrelatedPin

$pinnedRoot = Join-Path $env:AppData 'Microsoft\Internet Explorer\Quick Launch\User Pinned'
Write-Log 'Before heal (real User Pinned dir)'
$null = Write-LnkDump 'pin-from-start' $pinFromStart
$null = Write-LnkDump 'pin-from-running' $pinFromRunning
$null = Write-LnkDump 'pin-from-start-1.7.3' $pinFromStart173
$null = Write-LnkDump 'pin-from-running-1.7.3' $pinFromRunning173
$null = Write-LnkDump 'unrelated-notepad' $unrelatedPin

$beforeStart = Get-LnkFingerprint $pinFromStart
$beforeRunning = Get-LnkFingerprint $pinFromRunning
$beforeStart173 = Get-LnkFingerprint $pinFromStart173
$beforeRunning173 = Get-LnkFingerprint $pinFromRunning173
$beforeUnrelated = Get-LnkFingerprint $unrelatedPin
Write-LnkFingerprint 'pin-from-start' $beforeStart
Write-LnkFingerprint 'pin-from-running' $beforeRunning
Write-LnkFingerprint 'pin-from-start-1.7.3' $beforeStart173
Write-LnkFingerprint 'pin-from-running-1.7.3' $beforeRunning173
Write-LnkFingerprint 'unrelated-notepad' $beforeUnrelated

Write-Log 'Invoking PR heal_pins_in on the real User Pinned directory'
$healedCount = Invoke-PinHeal $pinnedRoot $exe
Write-Log "heal_pins_in returned healed=$healedCount"

Write-Log 'After heal'
$startPinHealed = Write-LnkDump 'pin-from-start' $pinFromStart
$runningPinHealed = Write-LnkDump 'pin-from-running' $pinFromRunning
$startPin173Healed = Write-LnkDump 'pin-from-start-1.7.3' $pinFromStart173
$runningPin173Healed = Write-LnkDump 'pin-from-running-1.7.3' $pinFromRunning173
$unrelatedAfter = Write-LnkDump 'unrelated-notepad' $unrelatedPin

$afterStart = Get-LnkFingerprint $pinFromStart
$afterRunning = Get-LnkFingerprint $pinFromRunning
$afterStart173 = Get-LnkFingerprint $pinFromStart173
$afterRunning173 = Get-LnkFingerprint $pinFromRunning173
$afterUnrelated = Get-LnkFingerprint $unrelatedPin
Write-LnkFingerprint 'pin-from-start' $afterStart
Write-LnkFingerprint 'pin-from-running' $afterRunning
Write-LnkFingerprint 'pin-from-start-1.7.3' $afterStart173
Write-LnkFingerprint 'pin-from-running-1.7.3' $afterRunning173
Write-LnkFingerprint 'unrelated-notepad' $afterUnrelated

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

function Assert-HealedStrandPin($Dump, $BeforeFp, $AfterFp, [string]$Name) {
    $usesInstaller = $Dump.IconPath -like '*\Installer\*'
    $usesExe = [string]::Equals($Dump.IconPath, $exe, [StringComparison]::OrdinalIgnoreCase)
    $emptyIcon = [string]::IsNullOrWhiteSpace($Dump.IconPath)
    $iconOk = ($usesExe -and $Dump.IconFileExists -eq $true) -or $emptyIcon
    if ($usesInstaller -or !$Dump.TargetExists -or !$iconOk) {
        $failures.Add("$Name was not healed to strand.exe/empty icon: IconLocation=$($Dump.IconLocation) iconExists=$($Dump.IconFileExists) targetExists=$($Dump.TargetExists)")
    } else {
        Write-Log "CONFIRMED: $Name now uses a durable icon ($($Dump.IconLocation))."
    }
    if (!$AfterFp.Exists) {
        $failures.Add("$Name .lnk is missing after heal; heal must not delete pins")
        return
    }
    if ($BeforeFp.CreationTimeUtc -ne $AfterFp.CreationTimeUtc) {
        $failures.Add("$Name CreationTime changed ($($BeforeFp.CreationTimeUtc) -> $($AfterFp.CreationTimeUtc)); heal must Save in place, not recreate")
    }
    if ($BeforeFp.Sha256 -eq $AfterFp.Sha256) {
        $failures.Add("$Name sha256 did not change after heal; expected SetIconLocation + Save")
    }
}

function Assert-UntouchedPin($BeforeDump, $AfterDump, $BeforeFp, $AfterFp, [string]$Name) {
    if ($BeforeDump.IconLocation -ne $AfterDump.IconLocation -or $BeforeDump.TargetPath -ne $AfterDump.TargetPath) {
        $failures.Add("$Name was rewritten: before IconLocation=$($BeforeDump.IconLocation) Target=$($BeforeDump.TargetPath); after IconLocation=$($AfterDump.IconLocation) Target=$($AfterDump.TargetPath)")
    } else {
        Write-Log "CONFIRMED: $Name IconLocation untouched ($($AfterDump.IconLocation))."
    }
    if ($BeforeFp.Sha256 -ne $AfterFp.Sha256) {
        $failures.Add("$Name sha256 changed ($($BeforeFp.Sha256) -> $($AfterFp.Sha256)); heal must not Save pins it does not select")
    }
    if ($BeforeFp.CreationTimeUtc -ne $AfterFp.CreationTimeUtc) {
        $failures.Add("$Name CreationTime changed; heal must not recreate unselected pins")
    }
}

Assert-StaleProductIconPin $startPinAfter173 '1.7.2 start pin after 1.7.3'
Assert-StaleProductIconPin $runningPinAfter173 '1.7.2 running-window pin after 1.7.3'
Assert-StaleProductIconPin $startPinAfter174 '1.7.2 start pin after 1.7.4'
Assert-StaleProductIconPin $runningPinAfter174 '1.7.2 running-window pin after 1.7.4'

Assert-HealthyPin $startPin173After174 '1.7.3 start pin after 1.7.4'
Assert-HealthyPin $runningPin173After174 '1.7.3 running-window pin after 1.7.4'

if ($healedCount -lt 2) {
    $failures.Add("heal_pins_in returned $healedCount; expected at least the two 1.7.2-era Strand pins")
} else {
    Write-Log "CONFIRMED: heal_pins_in rewrote $healedCount pin(s)."
}

Assert-HealedStrandPin $startPinHealed $beforeStart $afterStart '1.7.2 start pin after heal'
Assert-HealedStrandPin $runningPinHealed $beforeRunning $afterRunning '1.7.2 running-window pin after heal'
Assert-UntouchedPin $startPin173After174 $startPin173Healed $beforeStart173 $afterStart173 '1.7.3 start pin after heal'
Assert-UntouchedPin $runningPin173After174 $runningPin173Healed $beforeRunning173 $afterRunning173 '1.7.3 running-window pin after heal'
Assert-UntouchedPin $unrelatedBefore $unrelatedAfter $beforeUnrelated $afterUnrelated 'unrelated notepad pin after heal'

Write-Log 'CI runner limits: no interactive desktop, no live taskbar bitmap, no HWND-pin from a visible Strand window. Pins are .lnk files in User Pinned\TaskBar with IconLocation copied the way Explorer copies the Start Menu shortcut when pinning by AppUserModelID. Heal is IShellLink SetIconLocation + Save on existing files; Explorer bitmap refresh (SHChangeNotify vs sign-out) is a live-desktop check.'

if ($failures.Count) {
    Write-Log ("Rehearsal FAILED:`n - " + ($failures -join "`n - "))
} else {
    Write-Log "Rehearsal log written to $LogPath"
    Write-Log 'Rehearsal PASSED'
}
$logLines | Set-Content -LiteralPath $LogPath -Encoding utf8
if ($failures.Count) {
    throw "MSI pin rehearsal failed with $($failures.Count) check(s)."
}
