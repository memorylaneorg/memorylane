#!/usr/bin/env bash
set -euo pipefail
TRAY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$TRAY_ROOT/.." && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
ARCH="$(uname -m)"
RELEASE="$TRAY_ROOT/release/$VERSION"
APP="$RELEASE/MemoryLane.app"
CONTENTS="$APP/Contents"
DMG_MOUNT="/Volumes/MemoryLane"

if [[ -e "$DMG_MOUNT" ]]; then
  echo "A volume is already mounted at $DMG_MOUNT; eject it and retry." >&2
  exit 1
fi

node "$TRAY_ROOT/scripts/prepare-runtime.mjs"
mkdir -p "$TRAY_ROOT/dist"
# The real, signed catalog this verifies against is already hosted - see
# docs/plugin-repository-deployment.md. Each platform has its own catalog
# (scripts/build-plugin-repository.mjs writes one per platform subdirectory,
# uploaded and updated independently of any other platform's) - ARCH is
# "arm64" on Apple Silicon, matching that subdirectory's name directly (Intel
# Mac/darwin-x64 isn't a supported release target for now). Override for a
# build that should point at a different catalog (e.g. a beta channel or a
# self-hosted mirror).
PLUGIN_CATALOG_URL="${MEMORYLANE_PLUGIN_CATALOG_URL:-https://memorylaneapp.org/plugins/v1/stable/darwin-$ARCH/catalog.json}"
# The real, signed feed this verifies against (same key as the plugin
# catalog - tray-go/updater.go's updatePublicKey) is published by
# scripts/publish-release.mjs's "update" mode - see
# docs/plugin-repository-deployment.md's "Core update feed". Override for a
# build that should point at a different feed instead (a beta channel, a
# self-hosted mirror); leave it pointed here otherwise, same as the plugin
# catalog URL above.
UPDATE_FEED_URL="${MEMORYLANE_UPDATE_FEED_URL:-https://memorylaneapp.org/updates/darwin-$ARCH/manifest.json}"
(cd "$TRAY_ROOT" && go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.updateFeedURL=$UPDATE_FEED_URL -X main.pluginCatalogURL=$PLUGIN_CATALOG_URL" -o dist/MemoryLane .)
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$TRAY_ROOT/dist/MemoryLane" "$CONTENTS/MacOS/MemoryLane"
cp "$TRAY_ROOT/assets/icon.icns" "$CONTENTS/Resources/MemoryLane.icns"
cp -R "$TRAY_ROOT/runtime" "$CONTENTS/Resources/runtime"
cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.memorylane.desktop</string><key>CFBundleName</key><string>MemoryLane</string><key>CFBundleDisplayName</key><string>MemoryLane</string><key>CFBundleExecutable</key><string>MemoryLane</string><key>CFBundleIconFile</key><string>MemoryLane.icns</string><key>CFBundleShortVersionString</key><string>$VERSION</string><key>CFBundleVersion</key><string>$VERSION</string><key>LSUIElement</key><true/></dict></plist>
EOF

if [[ "${SIGN_RELEASE:-}" == "1" ]]; then
  IDENTITY="${MACOS_SIGNING_IDENTITY:-Developer ID Application: Humanly Incorporated (RNTVBNC62M)}"
  SIGN_ARGS=(--force --options runtime --timestamp --sign "$IDENTITY")
else
  # Copies of signed Mach-O files retain their original signature. Some Node
  # installations have a stale/invalid signature that macOS tolerates in a
  # terminal but kills with SIGTRAP inside an app bundle. Ad-hoc signing makes
  # local builds launchable and gives the enclosing bundle a valid seal.
  IDENTITY="-"
  SIGN_ARGS=(--force --options runtime --sign "$IDENTITY")
fi

# Pick up Node, native addons, dylibs and extensionless tools such as ffmpeg,
# while skipping executable-bit JavaScript/shell files and non-macOS binaries
# that npm packages also ship for other platforms.
while IFS= read -r file; do
  if file "$file" | grep -q 'Mach-O'; then
    if [[ "$(basename "$file")" == "node-runtime" ]]; then
      codesign "${SIGN_ARGS[@]}" --entitlements "$TRAY_ROOT/assets/node-runtime-entitlements.plist" "$file"
    else
      codesign "${SIGN_ARGS[@]}" "$file"
    fi
  fi
done < <(find "$CONTENTS/Resources/runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -name 'node-runtime' -o -perm -u+x \))
codesign "${SIGN_ARGS[@]}" --deep "$APP"
codesign --verify --deep --strict "$APP"

DMG="$RELEASE/MemoryLane-$ARCH.dmg"
rm -f "$DMG"

# Build a conventional drag-to-Applications disk image. A writable image is
# needed briefly so Finder can persist its icon positions, window geometry,
# and background into .DS_Store before the final compressed image is made.
DMG_WORK="$(mktemp -d /private/tmp/memorylane-dmg.XXXXXX)"
DMG_STAGE="$DMG_WORK/root"
DMG_RW="$DMG_WORK/MemoryLane-rw.dmg"
DMG_MOUNTED=0
cleanup_dmg() {
  if [[ "$DMG_MOUNTED" == "1" ]]; then hdiutil detach "$DMG_MOUNT" -quiet || true; fi
  rm -rf "$DMG_WORK"
}
trap cleanup_dmg EXIT

mkdir -p "$DMG_STAGE/.background"
cp -R "$APP" "$DMG_STAGE/MemoryLane.app"
ln -s /Applications "$DMG_STAGE/Applications"
cp "$TRAY_ROOT/assets/dmg/background.png" "$DMG_STAGE/.background/background.png"

hdiutil create -volname MemoryLane -srcfolder "$DMG_STAGE" -ov -format UDRW -fs HFS+ "$DMG_RW" >/dev/null
hdiutil attach "$DMG_RW" -readwrite -noverify -noautoopen -mountpoint "$DMG_MOUNT" >/dev/null
DMG_MOUNTED=1
# Finder does not add a no-auto-open volume to its scripting object model
# until the volume has been opened once.
open "$DMG_MOUNT"
sleep 2

osascript <<EOF
tell application "Finder"
  tell disk "MemoryLane"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set sidebar width of container window to 0
    set the bounds of container window to {120, 120, 780, 520}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 104
    set text size of viewOptions to 14
    set background picture of viewOptions to file ".background:background.png"
    set position of item "MemoryLane.app" of container window to {175, 190}
    set position of item "Applications" of container window to {485, 190}
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF

sync
hdiutil detach "$DMG_MOUNT" -quiet
DMG_MOUNTED=0
hdiutil convert "$DMG_RW" -format ULFO -o "$DMG" >/dev/null
rm -rf "$DMG_WORK"
trap - EXIT
if [[ "${SIGN_RELEASE:-}" == "1" ]]; then
  : "${APPLE_NOTARY_KEYCHAIN_PROFILE:?APPLE_NOTARY_KEYCHAIN_PROFILE is required}"
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple -v "$DMG"
fi

# Mirrors the plugin catalog's own dist/plugin-repository/ and the update
# manifest's dist/updates/ - one place under dist/ to gather everything that
# eventually gets published, instead of also having to remember
# tray-go/release/<version>/ separately (see package-windows.ps1's own copy
# of this step).
DIST_INSTALLER_DIR="$REPO_ROOT/dist/installer"
mkdir -p "$DIST_INSTALLER_DIR"
cp "$DMG" "$DIST_INSTALLER_DIR/MemoryLane-$ARCH.dmg"

echo "MemoryLane desktop package: $RELEASE"
