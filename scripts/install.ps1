param(
    [string]$CodePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Updated from package.json by npm run package:vsix.
$ExtensionVersion = '0.5.13'
$ExtensionId = 'weivea.copilot-agent-mesh'
$AssetName = "copilot-agent-mesh-$ExtensionVersion-preview.vsix"
$ReleaseUrl = "https://github.com/weivea/copilot-agent-mesh/releases/download/v$ExtensionVersion"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This installer requires Windows. On macOS, use install.sh.'
}

if ($CodePath) {
    $CodeCommand = Get-Command -Name $CodePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
    $CodeCommand = Get-Command -Name 'code' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $CodeCommand) {
        foreach ($InstallRoot in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not $InstallRoot) { continue }
            $RelativePath = 'Microsoft VS Code\bin\code.cmd'
            if ($InstallRoot -eq $env:LOCALAPPDATA) {
                $RelativePath = "Programs\$RelativePath"
            }
            $Candidate = Join-Path $InstallRoot $RelativePath
            if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
                $CodeCommand = Get-Command -Name $Candidate -CommandType Application -ErrorAction Stop
                break
            }
        }
    }
}

if (-not $CodeCommand) {
    throw 'VS Code CLI was not found. Install VS Code, add code to PATH, or run install.ps1 -CodePath <path-to-code.cmd>.'
}

$TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "copilot-agent-mesh-install-$([Guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $TemporaryDirectory
try {
    $VsixPath = Join-Path $TemporaryDirectory $AssetName
    $ChecksumPath = "$VsixPath.sha256"
    Write-Host "Downloading Copilot Agent Mesh $ExtensionVersion from $ReleaseUrl"
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$AssetName.sha256" -OutFile $ChecksumPath -TimeoutSec 300
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$AssetName" -OutFile $VsixPath -TimeoutSec 300

    $Checksum = [IO.File]::ReadAllText($ChecksumPath)
    $ChecksumPattern = '\A([a-f0-9]{64})  ' + [regex]::Escape($AssetName) + '\r?\n?\z'
    if ($Checksum -cnotmatch $ChecksumPattern) {
        throw 'The release checksum file is invalid. Installation was not attempted.'
    }
    $ExpectedHash = $Matches[1]
    $ActualHash = (Get-FileHash -LiteralPath $VsixPath -Algorithm SHA256).Hash
    if ($ActualHash -ine $ExpectedHash) {
        throw 'The VSIX SHA-256 checksum does not match. Installation was not attempted.'
    }

    & $CodeCommand.Source --install-extension $VsixPath --force
    if ($LASTEXITCODE -ne 0) {
        throw "VS Code extension installation failed (exit code $LASTEXITCODE)."
    }
    $InstalledExtensions = @(& $CodeCommand.Source --list-extensions --show-versions)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to verify the installed extension (exit code $LASTEXITCODE)."
    }
    if ($InstalledExtensions -notcontains "$ExtensionId@$ExtensionVersion") {
        throw "VS Code did not report $ExtensionId@$ExtensionVersion as installed."
    }
    Write-Host "Installed $ExtensionId@$ExtensionVersion. Reload VS Code to use it."
} finally {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
}
