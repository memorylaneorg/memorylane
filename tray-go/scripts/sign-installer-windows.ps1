param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InstallerExe
)

$ErrorActionPreference = "Stop"

$SignTool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"

$Dlib = "C:\codesigning\Microsoft.ArtifactSigning.Client.1.0.128\bin\x64\Azure.CodeSigning.Dlib.dll"

$Metadata = "C:\codesigning\metadata.json"

Write-Host "Signing MemoryLane Desktop installer"
Write-Host "File: $InstallerExe"

if (!(Test-Path $SignTool)) {
    throw "SignTool not found: $SignTool"
}

if (!(Test-Path $Dlib)) {
    throw "Artifact Signing DLIB not found: $Dlib"
}

if (!(Test-Path $Metadata)) {
    throw "Artifact Signing metadata not found: $Metadata"
}

if (!(Test-Path $InstallerExe)) {
    throw "Installer executable not found: $InstallerExe"
}

& $SignTool sign `
    /v `
    /fd SHA256 `
    /tr "http://timestamp.acs.microsoft.com" `
    /td SHA256 `
    /dlib $Dlib `
    /dmdf $Metadata `
    $InstallerExe

if ($LASTEXITCODE -ne 0) {
    throw "Installer signing failed with exit code $LASTEXITCODE"
}

Write-Host "Verifying installer signature..."

& $SignTool verify `
    /pa `
    /v `
    $InstallerExe

if ($LASTEXITCODE -ne 0) {
    throw "Installer signature verification failed with exit code $LASTEXITCODE"
}

Write-Host "Successfully signed and verified:"
Write-Host $InstallerExe
