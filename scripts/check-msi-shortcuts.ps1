param([Parameter(Mandatory = $true)][string]$MsiPath)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath "$PSScriptRoot/../crates/strand-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $MsiPath).Path, 0)

# Inspect the compiled artifact: a pinned copy must never depend on an MSI
# ProductIcon cache that disappears when the previous product is uninstalled.
$view = $database.OpenView('SELECT `Shortcut`, `Target`, `Icon_`, `IconIndex` FROM `Shortcut`')
try {
    $view.Execute()
    $shortcuts = @{}
    while ($record = $view.Fetch()) {
        $shortcuts[$record.StringData(1)] = @{
            Target = $record.StringData(2)
            Icon = $record.StringData(3)
            IconIndex = $record.StringData(4)
        }
    }
    foreach ($id in @('ApplicationStartMenuShortcut', 'ApplicationDesktopShortcut')) {
        $shortcut = $shortcuts[$id]
        if (!$shortcut -or $shortcut.Target -ne '[!Path]' -or $shortcut.Icon -or $shortcut.IconIndex) {
            throw "$id must use the installed executable icon, not the MSI icon cache."
        }
    }
} finally {
    $view.Close()
}

$view = $database.OpenView('SELECT `Shortcut_`, `PropertyKey`, `PropVariantValue` FROM `MsiShortcutProperty`')
try {
    $view.Execute()
    $identityFound = $false
    while ($record = $view.Fetch()) {
        if ($record.StringData(1) -eq 'ApplicationStartMenuShortcut' -and
            $record.StringData(2) -eq 'System.AppUserModel.ID' -and
            $record.StringData(3) -eq $config.identifier) {
            $identityFound = $true
        }
    }
    if (!$identityFound) { throw 'MSI Start Menu shortcut is missing the application identity.' }
} finally {
    $view.Close()
}

$view = $database.OpenView('SELECT `Action` FROM `InstallExecuteSequence` WHERE `Action`=''LaunchApplication'' OR `Action`=''LaunchApplicationViaExplorer''')
try {
    $view.Execute()
    $launch = @()
    while ($record = $view.Fetch()) { $launch += $record.StringData(1) }
    if (($launch -join ',') -ne 'LaunchApplicationViaExplorer') {
        throw "The updater relaunch must start strand.exe through explorer.exe, found: $($launch -join ', ')."
    }
} finally {
    $view.Close()
}

Write-Host 'MSI shortcuts use the installed executable icon and retain the application identity.'
