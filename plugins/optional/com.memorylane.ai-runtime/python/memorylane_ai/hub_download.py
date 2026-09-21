"""Loading ONNX graphs fetched via huggingface_hub, with one self-healing retry.

huggingface_hub.snapshot_download() trusts an already-cached file without
re-verifying it - if the cache gets corrupted after a successful download (a
partial write from a crash, antivirus interfering mid-write, a bad disk
sector), every future load keeps failing the same way, and the only fix is
someone manually finding and deleting the cache directory. Real report: a
fresh Windows install hit exactly this on the CLIP vision model
(onnxruntime.InvalidArgument loading vision_model.onnx), and the sidecar had
no way to recover on its own.

An ONNX session failing to parse a file *is* the corruption signal here,
since there's no per-file checksum available for a moving HF revision the
way memorylane_ai/face_model.py's ensure_model() has for its two fixed-URL
Apache models. So: try loading, and if that raises, wipe the local snapshot
and force a fresh download before retrying once.
"""
import shutil

from huggingface_hub import snapshot_download


def load_from_hub(repo: str, allow_patterns: list[str], load_fn):
    """Downloads `repo` (see snapshot_download's `allow_patterns`) and calls
    `load_fn(local_snapshot_path)`, retrying once with a forced re-download if
    the first attempt raises."""
    path = snapshot_download(repo, allow_patterns=allow_patterns)
    try:
        return load_fn(path)
    except Exception:
        shutil.rmtree(path, ignore_errors=True)
        path = snapshot_download(repo, allow_patterns=allow_patterns, force_download=True)
        return load_fn(path)
