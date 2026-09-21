# MemoryLane Plugin SDK

This package defines the data boundary shared by MemoryLane core and first-party plugins. It contains schemas and helpers only; it does not load plugins, access the core database, or implement server behavior.

## Package layout

Each `.mlplugin` archive contains one platform-specific immutable build:

```text
manifest.json
dist/                  bundled JavaScript modules, when used
bin/                   service and command executables
migrations/            reserved for future namespaced migrations
licenses/              third-party notices referenced by the manifest
package-signature.json artifact signature metadata
```

All paths in a manifest use `/`, are relative to the archive root, and must already be normalized. Absolute paths, `..`, backslashes, drive letters, and empty paths are rejected.

## Installation locations

Plugin code is installed outside the replaceable application bundle:

- Windows: `%LOCALAPPDATA%/MemoryLane/Plugins/<plugin-id>/<version>/`
- macOS: `~/Library/Application Support/MemoryLane/Plugins/<plugin-id>/<version>/`

Mutable data belongs under `<memorylane-data-dir>/plugin-data/<plugin-id>/`. Downloads and staging directories are siblings of installed plugin code and never become part of the core installer.

The core process remains the only owner of the core SQLite connection. A plugin uses a versioned core API for catalog reads or writes and never opens `memorylane.sqlite` directly.

Catalog signatures cover the exact UTF-8 bytes of `catalog.json`. Artifact signatures cover the 32 raw bytes represented by the artifact's SHA-256 field, allowing large packages to be verified without loading them fully into memory.

## Compatibility

`pluginApi` is an integer protocol version. `requiresCore` and dependency versions use exact versions or whitespace-separated `<`, `<=`, `>`, and `>=` comparisons, such as `>=0.4.0 <0.6.0`. Keeping this grammar small makes validation identical in the publisher and installer.
