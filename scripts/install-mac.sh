#!/bin/bash
# Installs Iris on this Mac:
#   1. builds the web UI
#   2. links the `iris` CLI into ~/.local/bin
#   3. creates ~/Applications/Iris.app (AppleScript applet: starts the daemon, opens Iris in a Chrome app window)
#   4. with --login: starts the daemon at login (launchd)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))')"
APP="$HOME/Applications/Iris.app"

echo "→ building web UI"
(cd "$REPO" && npm run build --silent -w @iris/web >/dev/null)

echo "→ linking iris CLI"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/iris" <<EOF
#!/bin/bash
exec "$NODE" --no-warnings=ExperimentalWarning "$REPO/packages/cli/src/main.ts" "\$@"
EOF
chmod +x "$HOME/.local/bin/iris"

echo "→ creating $APP"
rm -rf "$APP"
# An AppleScript applet is a real, ad-hoc signed Mach-O launcher; bundles whose executable is a
# shell script are refused by Launch Services on recent macOS (error -10669).
osacompile -o "$APP" -e 'do shell script quoted form of (POSIX path of (path to me) & "Contents/Resources/launch.sh") & " >/dev/null 2>&1 &"'
cp "$REPO/packages/desktop/Iris.icns" "$APP/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.iris.mail" "$APP/Contents/Info.plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string app.iris.mail" "$APP/Contents/Info.plist"
cat > "$APP/Contents/Resources/launch.sh" <<EOF
#!/bin/bash
# Iris launcher: make sure the local daemon runs, then open the UI as an app window.
"$NODE" --no-warnings=ExperimentalWarning "$REPO/packages/cli/src/main.ts" start >/dev/null 2>&1
INFO="\$HOME/Library/Application Support/Iris/daemon.json"
PORT="\$(/usr/bin/plutil -extract port raw -o - "\$INFO" 2>/dev/null || echo 7787)"
URL="http://127.0.0.1:\$PORT/"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "\$CHROME" ]; then
  exec "\$CHROME" --app="\$URL"
else
  open "\$URL"
fi
EOF
chmod +x "$APP/Contents/Resources/launch.sh"
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
touch "$APP"

if [[ "${1:-}" == "--login" ]]; then
  echo "→ starting Iris at login"
  "$HOME/.local/bin/iris" daemon install
fi

echo "✓ Iris installed. Open it from Spotlight (Iris) or run: iris open"
echo "  MCP for Claude Code: claude mcp add --scope user iris -- \"$NODE\" --no-warnings=ExperimentalWarning \"$REPO/packages/mcp/src/main.ts\""
