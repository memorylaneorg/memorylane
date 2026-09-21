# Architecture overview

MemoryLane has four core npm workspaces and a small Go desktop host.

- `client/` is the React browser interface.
- `server/` is the Fastify API, scanner, job runner, SQLite owner, media pipeline, and plugin host.
- `shared/` contains contracts shared by client and server.
- `plugin-sdk/` contains first-party plugin manifest and runtime contracts.
- `tray-go/` supervises the packaged server, exposes tray actions, and manages core updates.

The server owns the core SQLite connection. It indexes media in place and writes generated thumbnails, previews, and analysis data beneath the configured data directory. The browser never receives arbitrary filesystem access.

Core includes functions every installation needs: folder scanning, SQLite metadata, authentication, EXIF extraction, RAW previews, image thumbnails, video probing, video posters, and opt-in video modernization. Features that carry large specialized runtimes or serve narrower workflows are plugins.

See [Plugin architecture](plugins.md) and [AI architecture](ai.md).
