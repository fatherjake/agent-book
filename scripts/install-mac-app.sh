#!/bin/zsh
# Builds "Agent Book.app" in ~/Applications (or the folder given as $1), for the Dock. The app runs
# scripts/launch-mac.sh from this checkout, so rerun this if you move the repo.
# Usage: npm run install-app [-- /path/to/folder]

set -euo pipefail
ROOT="${0:A:h:h}"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Agent Book.app"
ICON="$ROOT/scripts/app-icon.png"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat >"$APP/Contents/MacOS/agent-book" <<EOF
#!/bin/zsh
exec "$ROOT/scripts/launch-mac.sh"
EOF
chmod +x "$APP/Contents/MacOS/agent-book" "$ROOT/scripts/launch-mac.sh"

cat >"$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Agent Book</string>
  <key>CFBundleIdentifier</key><string>local.agent-book.launcher</string>
  <key>CFBundleExecutable</key><string>agent-book</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

ICONSET="$TMP/AppIcon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ICON" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Make Finder and the Dock pick up the new icon.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"

echo "Installed $APP (runs $ROOT/scripts/launch-mac.sh)"
echo "Drag it to the Dock to launch Agent Book from there."
