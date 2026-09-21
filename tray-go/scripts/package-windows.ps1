param([switch]$Installer)
$ErrorActionPreference = "Stop"
$TrayRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $TrayRoot "..")).Path
$Version = (Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json).version
$ReleaseRoot = Join-Path $TrayRoot "release\$Version"
$Stage = Join-Path $ReleaseRoot "MemoryLane-win32-x64"

node (Join-Path $PSScriptRoot "prepare-runtime.mjs")
# The real, signed catalog this verifies against is already hosted - see
# docs/plugin-repository-deployment.md. Each platform has its own catalog
# (scripts/build-plugin-repository.mjs writes one per platform subdirectory,
# uploaded and updated independently of any other platform's), so this is
# always the win32-x64 one. Override for a build that should point at a
# different catalog (e.g. a beta channel or a self-hosted mirror).
$PluginCatalogUrl = if ($env:MEMORYLANE_PLUGIN_CATALOG_URL) { $env:MEMORYLANE_PLUGIN_CATALOG_URL } else { "https://memorylaneapp.org/plugins/v1/stable/win32-x64/catalog.json" }
# The real, signed feed this verifies against (same key as the plugin
# catalog - tray-go/updater.go's updatePublicKey) is published by
# scripts/publish-release.mjs's "update" mode - see
# docs/plugin-repository-deployment.md's "Core update feed". Override for a
# build that should point at a different feed instead (a beta channel, a
# self-hosted mirror); leave it pointed here otherwise, same as the plugin
# catalog URL above.
$UpdateFeedUrl = if ($env:MEMORYLANE_UPDATE_FEED_URL) { $env:MEMORYLANE_UPDATE_FEED_URL } else { "https://memorylaneapp.org/updates/win32-x64/manifest.json" }
Push-Location $TrayRoot
try {
  # Windows Explorer and the Start menu read the application icon from the
  # executable, not from Inno Setup's SetupIconFile. Generate a temporary Go
  # resource object so the packaged tray executable carries the icon and
  # useful file properties of its own.
  $ResourceObject = Join-Path $TrayRoot "rsrc_windows_amd64.syso"
  Remove-Item -LiteralPath $ResourceObject -Force -ErrorAction SilentlyContinue
  go run github.com/tc-hib/go-winres@v0.3.3 simply `
    --icon "assets\icon.ico" `
    --manifest gui `
    --arch amd64 `
    --out rsrc `
    --product-name "MemoryLane" `
    --file-description "MemoryLane photo and video library" `
    --original-filename "MemoryLane.exe" `
    --product-version $Version `
    --file-version $Version
  if ($LASTEXITCODE -ne 0) { throw "Could not generate Windows application resources" }
  go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$Version -X main.updateFeedURL=$UpdateFeedUrl -X main.pluginCatalogURL=$PluginCatalogUrl" -o "dist\MemoryLane.exe" .
  if ($LASTEXITCODE -ne 0) { throw "Go build failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath (Join-Path $TrayRoot "rsrc_windows_amd64.syso") -Force -ErrorAction SilentlyContinue
  Pop-Location
}

if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null
Copy-Item (Join-Path $TrayRoot "dist\MemoryLane.exe") (Join-Path $Stage "MemoryLane.exe")
Copy-Item (Join-Path $TrayRoot "runtime") (Join-Path $Stage "runtime") -Recurse

if ($env:SIGN_RELEASE -eq "1") {
  & (Join-Path $PSScriptRoot "sign-app-windows.ps1") (Join-Path $Stage "MemoryLane.exe")
  & (Join-Path $PSScriptRoot "sign-app-windows.ps1") (Join-Path $Stage "runtime\node-runtime.exe")
  # exiftool-vendored/ffmpeg-static/ffprobe-static's own executables - core
  # dependencies now (see server/src/media/exiftool-client.ts,
  # video-client.ts), not a separately-signed plugin anymore, so their
  # binaries need explicit coverage here instead.
  # -File matters here, not just style - exiftool-vendored's own npm package
  # is literally a directory named "exiftool-vendored.exe" (its real .exe is
  # inside, at bin\exiftool.exe), which -Filter "*.exe" alone would match and
  # hand to the signer as if it were a PE file.
  $VendoredExecutables = Get-ChildItem (Join-Path $Stage "runtime\node_modules") -File -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue
  foreach ($executable in $VendoredExecutables) {
    & (Join-Path $PSScriptRoot "sign-app-windows.ps1") $executable.FullName
  }
}

$Zip = Join-Path $ReleaseRoot "MemoryLane-win32-x64.zip"
Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Stage\*" -DestinationPath $Zip -CompressionLevel Optimal

if ($Installer) {
  # installer.iss uses SetupArchitecture=x64, an Inno Setup 7+ directive -
  # ISCC.exe isn't added to PATH by its own installer, so fall back to the
  # default install location before giving up.
  $Iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  $IsccPath = if ($Iscc) { $Iscc.Source } else {
    $defaultPath = Join-Path ${env:ProgramFiles} "Inno Setup 7\ISCC.exe"
    if (Test-Path -LiteralPath $defaultPath) { $defaultPath } else { $null }
  }
  if (-not $IsccPath) { throw "Inno Setup 7 (ISCC.exe) is required to build the Windows installer" }
  & $IsccPath "/DSourceDir=$Stage" "/DOutputDir=$ReleaseRoot" "/DAppVersion=$Version" (Join-Path $TrayRoot "installer.iss")
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
  $Setup = Join-Path $ReleaseRoot "MemoryLane-Setup.exe"
  if ($env:SIGN_RELEASE -eq "1") { & (Join-Path $PSScriptRoot "sign-installer-windows.ps1") $Setup }

  # Mirrors the plugin catalog's own dist/plugin-repository/ and the update
  # manifest's dist/updates/ - one place under dist/ to gather everything
  # that eventually gets published, instead of also having to remember
  # tray-go/release/<version>/ separately.
  $DistInstallerDir = Join-Path $RepoRoot "dist\installer"
  New-Item -ItemType Directory -Force $DistInstallerDir | Out-Null
  Copy-Item -LiteralPath $Setup (Join-Path $DistInstallerDir "MemoryLane-Setup.exe") -Force
}

Write-Host "MemoryLane desktop package: $ReleaseRoot"
