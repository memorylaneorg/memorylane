# MemoryLane AI Runtime

This is the Python source for MemoryLane’s optional local inference service. It provides CLIP image/text embeddings and face analysis for AI Search, Find Similar, smarter stacks, and People. Core sends JPEG bytes or text over authenticated loopback HTTP; the service does not receive original media paths or open the core database.

Packaged users install **AI Runtime** from Settings → Plugins. The plugin host starts, authenticates, monitors, restarts, and updates the service. Python is needed only for source development.

## Run from source

From the repository root:

```bash
npm run ai
```

The launcher finds Python 3.11+, creates `.venv` in this directory, installs dependencies, and starts the service. The first inference downloads the selected models.

Manual setup from this directory:

```bash
python -m venv .venv
# macOS/Linux: .venv/bin/pip install -e ".[dev]"
# Windows:     .venv\Scripts\pip install -e ".[dev]"
```

Then run `.venv/bin/memorylane-ai` on macOS/Linux or `.venv\Scripts\memorylane-ai` on Windows.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORYLANE_AI_HOST` | `127.0.0.1` | Service bind address; plugin installations keep this on loopback |
| `MEMORYLANE_AI_PORT` | `4281` | Standalone development port; the plugin host assigns its own port |
| `MEMORYLANE_AI_MODEL` | `Xenova/clip-vit-base-patch32` | Hugging Face repository containing the ONNX CLIP export |
| `MEMORYLANE_AI_FACE_MODEL` | `yunet-sface` | `yunet-sface` or opt-in `buffalo_l` |
| `MEMORYLANE_AI_DEVICE` | `cpu` | `cpu`, `cuda`, `dml`, `coreml`, or `auto` |
| `MEMORYLANE_AI_TOKEN` | unset | Bearer token for standalone development; the plugin host supplies one automatically |
| `MEMORYLANE_AI_MAX_BATCH` | `32` | Maximum images per embedding request |

`buffalo_l` is an InsightFace model restricted to non-commercial research use unless separately licensed. It is optional and never the default. See the plugin license file and the repository’s `THIRD_PARTY_NOTICES.md` before enabling or redistributing models.

## Endpoints

- `GET /v1/health`
- `POST /v1/embed/image`
- `POST /v1/embed/text`
- face-analysis endpoints used by the People plugin

## Tests

```bash
.venv/bin/pytest -q
```

On Windows, run `.venv\Scripts\pytest -q`.
