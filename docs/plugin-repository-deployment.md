# Plugin repository deployment

MemoryLane distributes plugins as signed static files over HTTPS. No registry service or database is required on the download host.

## Build a platform repository

Native service plugins must be prepared on their target platform before packaging. AI Runtime supports the release platforms declared in its manifest; Apple Photos is built on macOS.

```bash
npm run plugins:prepare-ai-runtime
npm run plugins:prepare-apple-photos   # macOS only
SIGN_RELEASE=1 npm run plugins:sign-native
npm run plugins:build -- stable
```

`MEMORYLANE_PLUGIN_SIGNING_KEY` may contain an Ed25519 private PEM or its path. Generate a key pair once with `npm run plugins:keygen`, store the private key in the release secret store, retain an offline backup, and commit only the public key.

Output is written beneath:

```text
dist/plugin-repository/v1/<channel>/<platform>/
  catalog.json
  catalog.json.sig
  release-manifest.json
  artifacts/
```

Each platform has an independent catalog because service executables are platform-specific. Build native artifacts on that platform; do not relabel a package produced elsewhere.

## Verify before upload

```bash
MEMORYLANE_PLUGIN_PUBLIC_KEY=/secure/plugin-public-key.pem \
  npm run plugins:verify -- dist/plugin-repository/v1/stable/win32-x64
```

Use the corresponding `darwin-arm64` path on Apple Silicon. Verification checks signatures, lengths, SHA-256 digests, manifests, platform, and compatibility.

## Publish atomically

Upload versioned files to a temporary sibling directory, verify `release-manifest.json` on the server, then rename the complete directory into place. With SFTP only, upload `artifacts/` first, `release-manifest.json` next, and `catalog.json` plus `catalog.json.sig` last.

Versioned artifacts are immutable. Roll back by publishing a newly signed catalog that points to the prior artifact; never replace an artifact at the same URL.

Recommended cache headers:

```nginx
location ~ ^/plugins/.*/(catalog\.json|catalog\.json\.sig)$ {
    add_header Cache-Control "no-cache";
}

location ~ ^/plugins/.*/artifacts/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Serve only over HTTPS. Configure packaged builds with `MEMORYLANE_PLUGIN_CATALOG_URL`; source builds may override it for testing.

## Development repository

```bash
npm run plugins:build -- stable development
```

This produces a temporary key pair and local repository. Set `MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY` and `MEMORYLANE_PLUGIN_PUBLIC_KEY` to its platform directory and generated public key. Never publish a development repository.

## Core updates

The Go tray uses a separately generated signed manifest and verifies installer SHA-256 before offering installation:

```bash
npm run desktop:update-manifest -- <installer> <public-url> <output.json>
npm run desktop:publish-update -- <platform>
```

Upload the installer before the manifest. Configure the packaged tray with `MEMORYLANE_UPDATE_FEED_URL`. Keep signing keys out of the repository and release artifacts.
