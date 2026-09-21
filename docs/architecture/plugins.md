# Plugin architecture

MemoryLane plugins are first-party packages selected to keep the core installer small. A signed platform catalog describes available versions and immutable artifacts.

## Package types

- **Module:** JavaScript loaded by the server through the plugin SDK.
- **Service:** A platform executable supervised by the plugin host. The host assigns a loopback port and a fresh bearer token, starts it, checks health, restarts failures within policy, and shuts it down with the application.
- **Command:** A short-lived executable invoked for a declared operation.

Manifests declare identity, version, compatible plugin API/core version, entry point, capabilities, dependencies, health policy, and included license files.

## Installation and updates

The plugin manager verifies the catalog signature, artifact size and SHA-256 digest, platform compatibility, and manifest before activating a version. It keeps the previous version during an update and restores it when startup health checks fail. Plugin updates and core updates are independent and can be checked from Settings.

Source development uses manifests directly from `plugins/optional/` unless a catalog or bundled repository is configured. Production artifacts are built into `dist/plugin-repository/v1/<channel>/<platform>/` for upload to a static HTTPS server.

## Data access

The core owns its SQLite connection and schema migrations. Plugins call registered core APIs for shared data instead of opening the core database file. A plugin may keep a separate SQLite database or generated files in its assigned data directory. Existing first-party AI tables remain in the core schema for compatibility; moving them is not required for the plugin split.

## Local service security

Service plugins bind to `127.0.0.1`. The host supplies a random token for every launch, and requests use bearer authentication. The token is not exposed to the browser. Loopback binding prevents remote network access; token authentication prevents another local web page from invoking a service directly.
