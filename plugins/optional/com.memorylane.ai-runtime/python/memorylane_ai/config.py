import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("MEMORYLANE_AI_HOST", "127.0.0.1")
    port: int = int(os.environ.get("MEMORYLANE_PLUGIN_PORT", os.environ.get("MEMORYLANE_AI_PORT", "4281")))
    model_repo: str = os.environ.get("MEMORYLANE_AI_MODEL", "Xenova/clip-vit-base-patch32")
    # cpu (default: fastest reliable choice measured on Apple Silicon), coreml, cuda, auto
    device: str = os.environ.get("MEMORYLANE_AI_DEVICE", "cpu")
    # yunet-sface (default, Apache-2.0) or buffalo_l (InsightFace ArcFace,
    # stronger, non-commercial license - opt-in for personal use).
    face_model: str = os.environ.get("MEMORYLANE_AI_FACE_MODEL", "yunet-sface")
    token: str | None = os.environ.get("MEMORYLANE_PLUGIN_TOKEN", os.environ.get("MEMORYLANE_AI_TOKEN", "")) or None
    data_dir: str = os.environ.get("MEMORYLANE_PLUGIN_DATA_DIR", os.environ.get("MEMORYLANE_AI_DATA_DIR", ".memorylane-ai"))
    max_batch: int = int(os.environ.get("MEMORYLANE_AI_MAX_BATCH", "32"))
