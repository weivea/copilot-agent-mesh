#!/bin/bash
set -euo pipefail

# Updated from package.json by npm run package:vsix.
EXTENSION_VERSION='0.5.13'
EXTENSION_ID='weivea.copilot-agent-mesh'
ASSET_NAME="copilot-agent-mesh-${EXTENSION_VERSION}-preview.vsix"
RELEASE_URL="https://github.com/weivea/copilot-agent-mesh/releases/download/v${EXTENSION_VERSION}"

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail 'This installer requires macOS. On Windows, use install.ps1.'
[[ $# -le 1 ]] || fail 'Usage: bash install.sh [path-to-code]'

if [[ $# -eq 1 ]]; then
    code_cli=$(command -v "$1") || fail "VS Code CLI was not found: $1"
elif code_cli=$(command -v code); then
    :
else
    code_cli=''
    for candidate in \
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' \
        "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
        if [[ -x "$candidate" ]]; then
            code_cli="$candidate"
            break
        fi
    done
fi
[[ -n "$code_cli" ]] || fail "Install VS Code, run 'Shell Command: Install code command in PATH', or pass the CLI path to install.sh."
command -v curl >/dev/null || fail 'curl was not found.'
command -v shasum >/dev/null || fail 'shasum was not found.'

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/copilot-agent-mesh-install.XXXXXXXX")
trap 'rm -rf -- "$temporary_directory"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
vsix_path="$temporary_directory/$ASSET_NAME"
checksum_path="$vsix_path.sha256"

download() {
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 300 \
        --output "$2" "$1" \
        || fail "Download failed: $1. Check that the release and its assets have been published."
}

printf 'Downloading Copilot Agent Mesh %s from %s\n' "$EXTENSION_VERSION" "$RELEASE_URL"
download "$RELEASE_URL/$ASSET_NAME.sha256" "$checksum_path"
download "$RELEASE_URL/$ASSET_NAME" "$vsix_path"

checksum=$(<"$checksum_path")
checksum_pattern='^([a-f0-9]{64})  (.+)$'
[[ "$checksum" =~ $checksum_pattern ]] || fail 'The release checksum file is invalid. Installation was not attempted.'
expected_hash="${BASH_REMATCH[1]}"
[[ "${BASH_REMATCH[2]}" == "$ASSET_NAME" ]] || fail 'The checksum names a different release asset. Installation was not attempted.'
actual_hash=$(shasum -a 256 "$vsix_path")
[[ "${actual_hash%% *}" == "$expected_hash" ]] || fail 'The VSIX SHA-256 checksum does not match. Installation was not attempted.'

"$code_cli" --install-extension "$vsix_path" --force || fail 'VS Code extension installation failed.'
installed_extensions=$("$code_cli" --list-extensions --show-versions) || fail 'Unable to verify the installed extension.'
installed_extensions=${installed_extensions//$'\r'/}
grep -Fx "$EXTENSION_ID@$EXTENSION_VERSION" <<< "$installed_extensions" >/dev/null \
    || fail "VS Code did not report $EXTENSION_ID@$EXTENSION_VERSION as installed."
printf 'Installed %s@%s. Reload VS Code to use it.\n' "$EXTENSION_ID" "$EXTENSION_VERSION"
