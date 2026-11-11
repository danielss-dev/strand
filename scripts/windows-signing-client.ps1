# Fetch the pinned Artifact Signing client (SignTool's Azure.CodeSigning dlib),
# write its metadata, and point scripts/windows-sign.ps1 at both through
# $GITHUB_ENV. Also writes a Tauri config that makes the bundler sign through
# that script, and returns its `--config` argument as the step output
# `tauri_args`. CI only (release.yml, when WINDOWS_SIGNING is on).
$ErrorActionPreference = 'Stop'

# Bump both together; the hash is the .nupkg from nuget.org.
$version = '1.0.128'
$sha256 = '74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b'
# The Artifact Signing account in Azure (rg-halterio-signing, East US).
$metadata = [ordered]@{
    Endpoint               = 'https://eus.codesigning.azure.net/'
    CodeSigningAccountName = 'halterio-signing'
    CertificateProfileName = 'public-trust'
}

$package = Join-Path $env:RUNNER_TEMP 'artifact-signing-client.zip'
Invoke-WebRequest -UseBasicParsing -OutFile $package `
    -Uri "https://www.nuget.org/api/v2/package/Microsoft.ArtifactSigning.Client/$version"
$actual = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $sha256) { throw "Microsoft.ArtifactSigning.Client $version is $actual, expected $sha256" }
$client = Join-Path $env:RUNNER_TEMP 'artifact-signing-client'
Expand-Archive -LiteralPath $package -DestinationPath $client -Force
$dlib = Join-Path $client 'bin/x64/Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path -LiteralPath $dlib)) { throw "No dlib in the package: $dlib" }

$metadataPath = Join-Path $env:RUNNER_TEMP 'artifact-signing.json'
$metadata | ConvertTo-Json | Set-Content -Encoding utf8NoBOM -LiteralPath $metadataPath
"WINDOWS_SIGN_DLIB=$dlib" >> $env:GITHUB_ENV
"WINDOWS_SIGN_METADATA=$metadataPath" >> $env:GITHUB_ENV

# Tauri splits signCommand on spaces and puts the file to sign in for %1, so
# the paths use forward slashes and have no spaces (GitHub's runner paths).
$script = (Join-Path $env:GITHUB_WORKSPACE 'scripts/windows-sign.ps1') -replace '\\', '/'
$tauriConfig = (Join-Path $env:RUNNER_TEMP 'tauri.windows-signing.conf.json') -replace '\\', '/'
if ("$script$tauriConfig" -match '\s') { throw "Signing paths must not contain spaces: $script, $tauriConfig" }
@{ bundle = @{ windows = @{ signCommand = "pwsh -NoLogo -NoProfile -NonInteractive -File $script %1" } } } |
    ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8NoBOM -LiteralPath $tauriConfig
"tauri_args=--config $tauriConfig" >> $env:GITHUB_OUTPUT
