# Deployment, development, and release builds

This guide covers source development, local plugin testing, desktop installers, signing, and publishing core and plugin updates.

## Supported build hosts

| Output | Build host | Additional tools |
| --- | --- | --- |
| Source/server | Windows, macOS, or Linux | Node.js 20+ and npm 10+ |
| Windows x64 ZIP and installer | Windows x64 | Go 1.25+, PowerShell, Inno Setup 7+ |
| macOS Apple Silicon app and DMG | Apple Silicon macOS | Go 1.25+, Xcode command-line tools |
| AI Runtime plugin | Its target operating system | Python 3.11–3.13 and PyInstaller preparation script |
| Apple Photos plugin | Apple Silicon macOS | Python 3.11–3.13 and macOS Photos access |

Native service plugins must be built on their target platform. The release scripts currently publish `win32-x64` and `darwin-arm64`; Intel macOS is not a configured release target.

ExifTool, FFmpeg, FFprobe, and Sharp are npm dependencies and are staged with the core runtime. Developers and end users do not install those tools separately.

## Source installation

```bash
git clone <repository-url>
cd memorylane
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4280`, create the first administrator account, and add scan folders under Settings. Copy `.env.example` to `.env` before setting local overrides.

To reset a forgotten password from the host:

```bash
npm run reset-password
npm run reset-password -- <username> <new-password>
```

## Daily development

Run the API and Vite client in separate terminals:

```bash
npm install
npm run dev
npm run dev:client
```

The Fastify server listens on port 4280. Vite listens on port 5173 and proxies `/api` to Fastify. For UI-only changes that must be served by an existing `npm start` process, run:

```bash
npm run build --workspace=client
```

For a production-style source run:

```bash
npm run build
npm start
```

Validation commands:

```bash
npm run typecheck
npm test
go -C tray-go test ./...
```

## Plugin development configurations

### Automatic source-tree catalog

When neither `MEMORYLANE_PLUGIN_CATALOG_URL` nor `MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY` is set, source runs discover plugin manifests directly under `plugins/optional/`. No archive, key, or catalog build is needed. Plugins appear under **Settings → Plugins**.

After changing a module plugin, disable and re-enable it or restart the server. A service plugin may declare a fixed `devPort` and run under its own watcher; core health-checks that process instead of supervising it. Such a service uses `DEV_SERVICE_TOKEN` from `@memorylane/plugin-sdk` for its development bearer token.

### AI Runtime from source

```bash
npm run ai
```

This creates the plugin’s private Python virtual environment when needed and starts the service on loopback. Packaged users install the self-contained AI Runtime plugin and do not need Python.

### Locally signed artifact pipeline

Use this configuration when changing catalog, signing, installation, update, or rollback behavior:

```bash
npm run build --workspace=plugin-sdk
npm run plugins:build -- stable development
```

The `development` argument creates a temporary signing key and places its public key in the generated platform repository. Configure `.env` with paths for the current platform:

```dotenv
MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY=dist/plugin-repository/v1/stable/win32-x64
MEMORYLANE_PLUGIN_PUBLIC_KEY=dist/plugin-repository/v1/stable/win32-x64/development-public-key.pem
```

Use `darwin-arm64` on Apple Silicon. Restart the server after changing these settings. Rebuild the repository after plugin changes; increase the plugin manifest version to exercise the Update path.

## Desktop tray development

The Go tray contains no webview. It supervises the bundled Node server, manages launch at login and updates, and opens the default browser.

```bash
npm run build
npm run desktop:runtime
go -C tray-go run .
```

After client, shared, or server changes, repeat the build and runtime-staging commands. Tray-only changes require only restarting `go run`.

For a process-supervision check without a tray UI:

```bash
go -C tray-go run . --smoke-test
```

## Data and configuration

| Platform | Default core data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\MemoryLane` |
| macOS | `~/Library/Application Support/MemoryLane` |
| Linux | `$XDG_DATA_HOME/MemoryLane` or `~/.local/share/MemoryLane` |

The directory contains SQLite, thumbnails, previews, logs, and generated analysis data. Installed plugin code and activation state use the plugin platform’s application-data directory. Original media remains in the configured scan folders.

Common environment variables are documented in `.env.example`. Release-related variables are described below. `npm run dev` and `npm start` load the repository-root `.env`; packaged applications do not depend on it.

The server binds to `127.0.0.1` by default. Enable **Allow Access outside this computer** under **Settings → Network** and restart MemoryLane for LAN access, or override the saved value with `MEMORYLANE_BIND_ADDRESS`. The built-in server does not terminate TLS; use an HTTPS reverse proxy before exposing it outside a trusted network.

## Release inputs and secrets

The core-update manifest and plugin catalog use the same first-party Ed25519 signing key.

| Setting | Purpose |
| --- | --- |
| `.keys/plugin-release-private.pem` | Default private signing key location; gitignored |
| `MEMORYLANE_PLUGIN_SIGNING_KEY` | Private PEM text or alternate private-key path |
| `MEMORYLANE_PLUGIN_PUBLIC_KEY` | Public PEM or path used during verification |
| `MEMORYLANE_PLUGIN_CATALOG_URL` | Catalog URL compiled into the tray |
| `MEMORYLANE_UPDATE_FEED_URL` | Core-update manifest URL compiled into the tray |
| `SIGN_RELEASE=1` | Enables production code signing and macOS notarization |
| `MEMORYLANE_DEPLOY_SSH_KEY` | Private SSH key path used by the upload script |
| `MEMORYLANE_DEPLOY_HOST` | Upload destination in `user@host` form |
| `MEMORYLANE_DEPLOY_ROOT` | Remote static-site root |

Generate the Ed25519 pair once:

```bash
npm run plugins:keygen
```

Copy the private key to the release secret store and retain an offline backup. Commit only the generated public key. Never place deployment or platform-signing credentials in Git.

## Build configurations

### Core web/server build only

```bash
npm install
npm run build
```

This builds the plugin SDK, shared contracts, React client, and server. It does not create a desktop runtime or installer.

### Windows staged folder and ZIP

```powershell
npm install
npm run build
npm run desktop:package
```

Output:

```text
tray-go/release/<version>/MemoryLane-win32-x64/
tray-go/release/<version>/MemoryLane-win32-x64.zip
```

### Windows installer

Install Go 1.25+ and Inno Setup 7+, then run:

```powershell
npm install
npm run build
npm run desktop:installer
```

Output:

```text
tray-go/release/<version>/MemoryLane-Setup.exe
dist/installer/MemoryLane-Setup.exe
```

The packaging script generates Windows executable resources from `tray-go/assets/icon.ico`, embeds the version and catalog/update URLs, stages the Node runtime, and builds the installer.

### Signed Windows installer

Configure the Azure Trusted Signing environment expected by `tray-go/scripts/sign-app-windows.ps1` and `sign-installer-windows.ps1`, then run:

```powershell
$env:SIGN_RELEASE = "1"
npm run desktop:installer
```

The package step signs `MemoryLane.exe`, `node-runtime.exe`, vendored native executables such as ExifTool/FFmpeg/FFprobe, and the final installer.

### macOS app and DMG

On Apple Silicon macOS:

```bash
npm install
npm run build
bash tray-go/scripts/package-macos.sh
```

Unsigned local builds use ad-hoc signing so the app bundle can launch. Output:

```text
tray-go/release/<version>/MemoryLane.app
tray-go/release/<version>/MemoryLane-arm64.dmg
dist/installer/MemoryLane-arm64.dmg
```

### Signed and notarized macOS DMG

Create a Developer ID Application certificate and a `notarytool` keychain profile, then run:

```bash
export SIGN_RELEASE=1
export MACOS_SIGNING_IDENTITY="Developer ID Application: Your Organization (TEAMID)"
export APPLE_NOTARY_KEYCHAIN_PROFILE="memorylane-notary"
bash tray-go/scripts/package-macos.sh
```

The script signs Mach-O executables, native Node modules, dylibs, the app bundle, and DMG; submits the DMG to Apple; waits for notarization; and staples the result.

## Build plugin catalogs separately

The optional catalog contains AI Runtime, AI Search & Similar, People, and Apple Photos. Metadata/RAW and video tools are core dependencies.

### Windows catalog

Run on Windows:

```powershell
npm run plugins:prepare-ai-runtime
if ($env:SIGN_RELEASE -eq "1") { npm run plugins:sign-native }
npm run plugins:build -- stable --platforms win32-x64
npm run plugins:verify -- dist/plugin-repository/v1/stable/win32-x64
```

### macOS catalog

Run on Apple Silicon macOS:

```bash
npm run plugins:prepare-ai-runtime
npm run plugins:prepare-apple-photos
if [[ "${SIGN_RELEASE:-}" == "1" ]]; then npm run plugins:sign-native; fi
npm run plugins:build -- stable --platforms darwin-arm64
npm run plugins:verify -- dist/plugin-repository/v1/stable/darwin-arm64
```

Each platform produces a self-contained directory under `dist/plugin-repository/v1/stable/<platform>/`. There is no cross-platform merge step. See [Plugin repository deployment](plugin-repository-deployment.md) for the file layout and atomic-upload requirements.

## One-command Windows release build

This is the normal Windows release command. It builds core, prepares and optionally signs AI Runtime, builds and verifies the Windows plugin catalog, builds the installer, and generates the matching signed core-update manifest.

Unsigned local release rehearsal:

```powershell
Remove-Item Env:\SIGN_RELEASE -ErrorAction SilentlyContinue
npm run build:windows-install
```

Signed production build:

```powershell
$env:SIGN_RELEASE = "1"
npm run build:windows-install
```

Expected publishable outputs:

```text
dist/installer/MemoryLane-Setup.exe
dist/plugin-repository/v1/stable/win32-x64/
dist/updates/win32-x64/manifest.json
```

The command does not upload anything.

After the production build succeeds, install and verify the generated package.
Then commit and push the exact release source and create its tag:

```powershell
git add .
git commit -m "Release vX.Y.Z"
git push origin main
npm run release:tag
```

`release:tag` reads the version from the root `package.json`, creates the
annotated `v<version>` tag, and pushes that tag to `origin`. It requires a clean
working tree and replaces both manual `git tag` and `git push origin <tag>`
commands. Tag after verifying the installer and before uploading the release.

## One-command macOS release build

This is the normal Apple Silicon release command. It builds core, prepares and optionally signs AI Runtime and Apple Photos, builds and verifies the macOS catalog, creates the app and DMG, notarizes when configured, and generates the matching core-update manifest.

Unsigned local release rehearsal:

```bash
unset SIGN_RELEASE
npm run build:mac-install
```

Signed production build:

```bash
export SIGN_RELEASE=1
export MACOS_SIGNING_IDENTITY="Developer ID Application: Your Organization (TEAMID)"
export APPLE_NOTARY_KEYCHAIN_PROFILE="memorylane-notary"
npm run build:mac-install
```

Expected publishable outputs:

```text
dist/installer/MemoryLane-arm64.dmg
dist/plugin-repository/v1/stable/darwin-arm64/
dist/updates/darwin-arm64/manifest.json
```

The command does not upload anything.

After the production build succeeds, install and verify the generated package.
Then commit and push the exact release source and create its tag:

```bash
git add .
git commit -m "Release vX.Y.Z"
git push origin main
npm run release:tag
```

The command creates and pushes the annotated tag for the version in
`package.json`. Do not also create the tag manually.

## Generate a core-update manifest manually

If you used the individual packaging commands, generate the signed update manifest against the exact installer that will be uploaded.

Windows:

```bash
npm run desktop:update-manifest -- dist/installer/MemoryLane-Setup.exe https://memorylaneapp.org/updates/win32-x64/MemoryLane-Setup.exe dist/updates/win32-x64/manifest.json
```

macOS:

```bash
npm run desktop:update-manifest -- dist/installer/MemoryLane-arm64.dmg https://memorylaneapp.org/updates/darwin-arm64/MemoryLane-arm64.dmg dist/updates/darwin-arm64/manifest.json
```

The generator uses `.keys/plugin-release-private.pem` unless `MEMORYLANE_PLUGIN_SIGNING_KEY` overrides it.

## Upload a complete Windows release

After inspecting the installer, catalog, and update manifest:

```powershell
$env:MEMORYLANE_DEPLOY_SSH_KEY = "C:\secure\memorylane-deploy.pem"
$env:MEMORYLANE_DEPLOY_HOST = "deploy@example.org"
$env:MEMORYLANE_DEPLOY_ROOT = "/var/www/memorylane"

npm run plugins:publish -- win32-x64
npm run desktop:publish-update -- win32-x64
```

Equivalent direct commands:

```bash
node scripts/publish-release.mjs catalog win32-x64
node scripts/publish-release.mjs update win32-x64
```

The catalog uploader swaps a complete platform directory into place. The core updater verifies that the local installer SHA-256 matches the signed manifest, uploads the installer first, and exposes the manifest last.

## Upload a complete macOS release

```bash
export MEMORYLANE_DEPLOY_SSH_KEY=/secure/memorylane-deploy.pem
export MEMORYLANE_DEPLOY_HOST=deploy@example.org
export MEMORYLANE_DEPLOY_ROOT=/var/www/memorylane

npm run plugins:publish -- darwin-arm64
npm run desktop:publish-update -- darwin-arm64
```

Equivalent direct commands:

```bash
node scripts/publish-release.mjs catalog darwin-arm64
node scripts/publish-release.mjs update darwin-arm64
```

Windows and macOS catalogs are independent. Publishing one does not modify the other.

## Release checklist

1. Update the version with `npm run version:bump -- <version>` and review every package/plugin manifest changed by it.
2. Run `npm install` if lockfile or dependencies changed.
3. Run `npm run typecheck`, `npm test`, and `go -C tray-go test ./...`.
4. Run the platform’s one-command build.
5. Install the generated package on a clean or isolated machine.
6. Verify first-run setup, scan folders, plugin onboarding, tray launch, browser opening, and Settings → Check for updates.
7. Verify the generated catalog and core-update manifest again.
8. Commit and push the exact release source; confirm the working tree is clean.
9. Run `npm run release:tag` to create and push the annotated tag for the current package version.
10. Upload the platform catalog.
11. Upload the installer and core-update manifest.
12. Confirm the public catalog, plugin artifacts, installer, and update manifest are reachable over HTTPS.
13. Keep the prior catalog directory available for operational rollback.

## Upgrade behavior

Core database migrations run automatically at startup in numeric order. Before pending migrations are applied, MemoryLane creates a timestamped SQLite backup and retains recent backups. Plugin updates do not require core schema changes unless a plugin capability explicitly ships with a compatible core migration.

The tray checks the signed core feed and shows available updates in the application. Plugin updates are checked through the signed platform catalog. A plugin activation that fails its startup health check rolls back to the previous healthy version.

## Troubleshooting

- **Inno Setup is not found:** install Inno Setup 7; its default `Program Files` location is detected automatically.
- **Windows signing fails:** verify Azure Trusted Signing prerequisites and run the signing script directly against a test executable.
- **macOS packaging stops before DMG creation:** eject any volume mounted at `/Volumes/MemoryLane` and retry.
- **macOS notarization fails:** inspect the `notarytool` result and verify the keychain profile and Developer ID identity.
- **Catalog verification fails:** verify the platform directory and public key match the private key used to build it.
- **Update publication rejects the installer:** regenerate the manifest against the exact file in `dist/installer/`.
- **A plugin is missing from the catalog:** prepare its native executable on the target platform and rerun `plugins:build`.
- **Port 4280 is busy:** stop the conflicting process or set `MEMORYLANE_PORT`.
- **macOS cannot read an external library:** grant Files and Folders access to the terminal or packaged MemoryLane application.
