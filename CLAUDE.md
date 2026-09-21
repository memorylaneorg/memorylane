# MemoryLane contributor notes

Read [README.md](README.md) and [docs/architecture/overview.md](docs/architecture/overview.md) before changing architecture.

## Repository layout

- `client/`: React and Vite UI
- `server/`: Fastify API, SQLite, scanners, jobs, media processing, plugin host
- `shared/`: shared browser/server contracts
- `plugin-sdk/`: first-party plugin contracts
- `plugins/optional/`: optional first-party plugins
- `tray-go/`: desktop supervisor and updater; no embedded webview

## Commands

```bash
npm run dev
npm run dev:client
npm run build
npm test
npm run typecheck
```

For UI-only changes, run `npm run build --workspace=client` so a server started with `npm start` can serve the updated files.

## Architecture constraints

- Original media is read-only unless the user explicitly confirms the video-modernization replacement flow.
- Core owns the main SQLite connection and migrations. Plugins use core APIs for shared data.
- Metadata/RAW and video tools are core. AI Runtime, AI Search, People, and Apple Photos are optional plugins.
- Service plugins bind to loopback and authenticate every request with the host-provided token.
- Keep generated runtimes, installers, catalogs, model caches, virtual environments, and executables out of Git.
- Update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when adding a dependency, native tool, model, or redistributable fixture.

Current deployment instructions are in [docs/deployment.md](docs/deployment.md); historical phase plans are intentionally excluded from the public repository.
