"""Face detection + identity embedding with Apache-2.0 models from OpenCV Zoo.

YuNet (2023mar, fixed 640x640 input) finds faces and 5 landmarks; SFace
(2021dec) turns a 112x112 aligned crop into a 128-d identity vector. Both are
plain ONNX graphs run through onnxruntime - no OpenCV, no compiler. Chosen
over InsightFace's stronger ArcFace models because those are licensed for
non-commercial research only, which would conflict with distributing
MemoryLane under MIT; the model id is part of every stored vector's space so
a different model can be offered later without a redesign.
"""
import hashlib
import io
import os
import ssl
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ZOO = "https://github.com/opencv/opencv_zoo/raw/main/models"
MODELS = {
    "yunet": (f"{ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    "sface": (f"{ZOO}/face_recognition_sface/face_recognition_sface_2021dec.onnx", "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
}
FACE_MODEL_ID = "yunet-sface@1"
FACE_DIM = 128
ARCFACE_MODEL_ID = "buffalo_l@1"
ARCFACE_DIM = 512
ARCFACE_REPO = "immich-app/buffalo_l"
DET_SIZE = 640
STRIDES = (8, 16, 32)
SCORE_THRESHOLD = 0.6
NMS_IOU = 0.3
MAX_FACES = 50
# ArcFace/SFace 112x112 alignment reference (left eye, right eye, nose, mouth corners).
REFERENCE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def cache_dir() -> Path:
    d = Path(os.environ.get("MEMORYLANE_AI_CACHE", Path.home() / ".cache" / "memorylane-ai"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(name: str) -> Path:
    url, digest = MODELS[name]
    path = cache_dir() / f"{name}.onnx"
    if path.exists() and _sha256(path) == digest:
        return path
    tmp = path.with_suffix(".part")
    req = urllib.request.Request(url, headers={"User-Agent": "memorylane-ai/0.1"})
    # python.org builds on macOS ship without system CA certificates for
    # urllib; certifi (pulled in by huggingface_hub) has a current bundle.
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover
        ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=120, context=ctx) as r, open(tmp, "wb") as f:
        for chunk in iter(lambda: r.read(1 << 20), b""):
            f.write(chunk)
    if _sha256(tmp) != digest:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum mismatch downloading {name} from {url}")
    tmp.replace(path)
    return path


@dataclass
class FaceDet:
    bbox: list[float]  # x, y, w, h normalised to the original image
    landmarks: list[list[float]]  # 5 x (x, y) normalised
    det_score: float
    embedding: np.ndarray  # float32[128], L2-normalised


def _umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform (scale, rotation, translation) src -> dst, as a 2x3 matrix."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = dc.T @ sc / len(src)
    u, d, vt = np.linalg.svd(cov)
    sign = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[1] = -1
    rot = u @ np.diag(sign) @ vt
    scale = (d * sign).sum() / ((sc**2).sum() / len(src))
    m = np.zeros((2, 3), dtype=np.float64)
    m[:, :2] = scale * rot
    m[:, 2] = mu_d - scale * rot @ mu_s
    return m


def _iou(a, b) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


class FaceModel:
    def __init__(self, providers: list):
        self.det = ort.InferenceSession(str(ensure_model("yunet")), providers=providers)
        self.rec = ort.InferenceSession(str(ensure_model("sface")), providers=providers)
        self.det_outputs = [o.name for o in self.det.get_outputs()]

    def _detect(self, img: Image.Image):
        w, h = img.size
        scale = DET_SIZE / max(w, h)
        rw, rh = max(1, round(w * scale)), max(1, round(h * scale))
        canvas = Image.new("RGB", (DET_SIZE, DET_SIZE), (0, 0, 0))
        canvas.paste(img.resize((rw, rh), Image.BILINEAR), (0, 0))
        x = np.asarray(canvas, dtype=np.float32)[:, :, ::-1].transpose(2, 0, 1)[None]  # BGR, 0-255
        out = dict(zip(self.det_outputs, self.det.run(None, {"input": x})))
        cands = []
        for s in STRIDES:
            cls, obj = out[f"cls_{s}"][0, :, 0], out[f"obj_{s}"][0, :, 0]
            bbox, kps = out[f"bbox_{s}"][0], out[f"kps_{s}"][0]
            n = DET_SIZE // s
            ys, xs = np.divmod(np.arange(n * n), n)
            score = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            cx, cy = (xs + bbox[:, 0]) * s, (ys + bbox[:, 1]) * s
            bw, bh = np.exp(bbox[:, 2]) * s, np.exp(bbox[:, 3]) * s
            kx, ky = (xs[:, None] + kps[:, 0::2]) * s, (ys[:, None] + kps[:, 1::2]) * s
            for i in np.where(score > SCORE_THRESHOLD)[0]:
                cands.append((float(score[i]), [cx[i] - bw[i] / 2, cy[i] - bh[i] / 2, bw[i], bh[i]], np.stack([kx[i], ky[i]], 1)))
        cands.sort(key=lambda c: -c[0])
        kept = []
        for c in cands:
            if all(_iou(c[1], k[1]) <= NMS_IOU for k in kept):
                kept.append(c)
            if len(kept) >= MAX_FACES:
                break
        # Back to original-image pixels.
        return [(s, np.array(box) / scale, k / scale) for s, box, k in kept], (w, h)

    def _align(self, img: Image.Image, kps: np.ndarray) -> Image.Image:
        m = _umeyama(kps.astype(np.float32), REFERENCE)
        a = np.vstack([m, [0, 0, 1]])
        inv = np.linalg.inv(a)  # PIL maps output -> input
        return img.transform((112, 112), Image.AFFINE, inv[:2].flatten(), resample=Image.BILINEAR)

    def _embed(self, crops: list[Image.Image]) -> np.ndarray:
        x = np.stack([np.asarray(c, dtype=np.float32)[:, :, ::-1].transpose(2, 0, 1) for c in crops])
        vs = np.concatenate([self.rec.run(None, {"data": x[i : i + 1]})[0] for i in range(len(x))])
        return vs / np.clip(np.linalg.norm(vs, axis=1, keepdims=True), 1e-12, None)

    def detect_and_embed(self, images: list[bytes]) -> list[list[FaceDet]]:
        results: list[list[FaceDet]] = []
        for data in images:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            dets, (w, h) = self._detect(img)
            faces: list[FaceDet] = []
            if dets:
                embs = self._embed([self._align(img, k) for _, _, k in dets])
                for (score, box, kps), emb in zip(dets, embs):
                    faces.append(
                        FaceDet(
                            bbox=[float(box[0] / w), float(box[1] / h), float(box[2] / w), float(box[3] / h)],
                            landmarks=[[float(px / w), float(py / h)] for px, py in kps],
                            det_score=score,
                            embedding=emb.astype(np.float32),
                        )
                    )
            results.append(faces)
        return results


def _nms(cands, iou_thr):
    cands.sort(key=lambda c: -c[0])
    kept = []
    for c in cands:
        if all(_iou(c[1], k[1]) <= iou_thr for k in kept):
            kept.append(c)
        if len(kept) >= MAX_FACES:
            break
    return kept


class ArcFaceModel(FaceModel):
    """InsightFace buffalo_l: SCRFD-10G detector + ArcFace-R50 recogniser (512-d).

    License: InsightFace model zoo weights are for non-commercial research use.
    Opt-in only (MEMORYLANE_AI_FACE_MODEL=buffalo_l); never the default.
    """

    NUM_ANCHORS = 2

    def __init__(self, providers: list):  # noqa: D107 - see class docstring
        from .hub_download import load_from_hub

        def load(path):
            det = ort.InferenceSession(f"{path}/detection/model.onnx", providers=providers)
            rec = ort.InferenceSession(f"{path}/recognition/model.onnx", providers=providers)
            return det, rec

        self.det, self.rec = load_from_hub(ARCFACE_REPO, ["detection/model.onnx", "recognition/model.onnx"], load)
        self.det_input = self.det.get_inputs()[0].name
        self.rec_input = self.rec.get_inputs()[0].name

    def _detect(self, img: Image.Image):
        w, h = img.size
        scale = DET_SIZE / max(w, h)
        rw, rh = max(1, round(w * scale)), max(1, round(h * scale))
        canvas = Image.new("RGB", (DET_SIZE, DET_SIZE), (0, 0, 0))
        canvas.paste(img.resize((rw, rh), Image.BILINEAR), (0, 0))
        x = ((np.asarray(canvas, dtype=np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]  # RGB
        outs = self.det.run(None, {self.det_input: x})
        cands = []
        for i, s in enumerate(STRIDES):
            scores, bbox, kps = outs[i][:, 0], outs[i + 3] * s, outs[i + 6] * s
            n = DET_SIZE // s
            ys, xs = np.divmod(np.arange(n * n), n)
            cx, cy = np.repeat(xs * s, self.NUM_ANCHORS), np.repeat(ys * s, self.NUM_ANCHORS)
            for k in np.where(scores > 0.5)[0]:
                x1, y1 = cx[k] - bbox[k, 0], cy[k] - bbox[k, 1]
                x2, y2 = cx[k] + bbox[k, 2], cy[k] + bbox[k, 3]
                kp = np.stack([cx[k] + kps[k, 0::2], cy[k] + kps[k, 1::2]], 1)
                cands.append((float(scores[k]), [x1, y1, x2 - x1, y2 - y1], kp))
        kept = _nms(cands, 0.4)
        return [(sc, np.array(box) / scale, k / scale) for sc, box, k in kept], (w, h)

    def _embed(self, crops: list[Image.Image]) -> np.ndarray:
        x = np.stack([((np.asarray(c, dtype=np.float32) - 127.5) / 127.5).transpose(2, 0, 1) for c in crops])  # RGB
        vs = np.concatenate([self.rec.run(None, {self.rec_input: x[i : i + 1]})[0] for i in range(len(x))])
        return vs / np.clip(np.linalg.norm(vs, axis=1, keepdims=True), 1e-12, None)


FACE_MODELS = {
    "yunet-sface": {"id": FACE_MODEL_ID, "dim": FACE_DIM, "license": "Apache-2.0", "label": "Standard (YuNet + SFace)"},
    "buffalo_l": {"id": ARCFACE_MODEL_ID, "dim": ARCFACE_DIM, "license": "non-commercial", "label": "ArcFace (InsightFace buffalo_l)"},
}


def face_model_id(name: str) -> tuple[str, int]:
    if name == "buffalo_l":
        return ARCFACE_MODEL_ID, ARCFACE_DIM
    if name in ("yunet-sface", "default"):
        return FACE_MODEL_ID, FACE_DIM
    raise ValueError(f"Unknown face model '{name}' (expected yunet-sface or buffalo_l)")


def create_face_model(name: str, providers: list) -> FaceModel:
    return ArcFaceModel(providers) if name == "buffalo_l" else FaceModel(providers)
