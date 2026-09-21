# MemoryLane native desktop tray

This is the production Windows/macOS tray and process supervisor. It does not contain a webview: the existing server serves MemoryLane in the user's browser.

```powershell
npm run build
npm run desktop:runtime
go -C tray-go run .
```

Use `npm run desktop:package` for a Windows folder and ZIP, or `npm run desktop:installer` for the Inno Setup installer. On macOS, run `bash tray-go/scripts/package-macos.sh` to create the app and DMG. `SIGN_RELEASE=1` enables platform signing.

The executable looks for `runtime/` beside itself on Windows and under the app's Resources directory on macOS. `MEMORYLANE_RUNTIME_DIR` overrides that path for development. `MEMORYLANE_TRAY_NO_AUTOSTART=1` starts only the tray, and `MEMORYLANE_TRAY_READY_FILE` writes a timestamp when the tray is ready for repeatable measurement.

Use `go run . --smoke-test` with `MEMORYLANE_RUNTIME_DIR` set to exercise real server startup and process-tree shutdown without creating a tray.
