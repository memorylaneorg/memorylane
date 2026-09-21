"""CLIP ViT-B/32 via a pre-exported ONNX graph (Xenova/clip-vit-base-patch32).

Loaded straight into onnxruntime - no PyTorch, no compiler - so the same code
runs on Windows, macOS and Linux with prebuilt wheels. Images and texts map
into one 512-d space, which is what gives MemoryLane both "find similar" and
"describe it" search from a single model.
"""
import io
from dataclasses import dataclass

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

from .hub_download import load_from_hub

MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
SIZE = 224
CONTEXT = 77
EOS = 49407


def _providers(device: str) -> list:
    available = ort.get_available_providers()
    if device == "auto":
        device = "cuda" if "CUDAExecutionProvider" in available else "cpu"
    if device == "cuda" and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if device == "dml" and "DmlExecutionProvider" in available:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    if device == "coreml" and "CoreMLExecutionProvider" in available:
        # The default NeuralNetwork format fails on this graph; MLProgram works
        # (measured ~5% faster than CPU on M2 Max, so CPU stays the default).
        return [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"}), "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


@dataclass(frozen=True)
class ModelInfo:
    id: str
    dim: int
    device: str
    providers: list[str]


class ClipModel:
    def __init__(self, repo: str, device: str = "cpu"):
        providers = _providers(device)

        def load(path):
            vision = ort.InferenceSession(f"{path}/onnx/vision_model.onnx", providers=providers)
            text = ort.InferenceSession(f"{path}/onnx/text_model.onnx", providers=providers)
            tokenizer = Tokenizer.from_file(f"{path}/tokenizer.json")
            tokenizer.enable_padding(pad_id=EOS, pad_token="<|endoftext|>", length=CONTEXT)
            tokenizer.enable_truncation(CONTEXT)
            return vision, text, tokenizer

        self.vision, self.text, self.tokenizer = load_from_hub(
            repo, ["onnx/vision_model.onnx", "onnx/text_model.onnx", "*.json", "*.txt"], load
        )
        dim = self.vision.get_outputs()[0].shape[-1]
        used = self.vision.get_providers()[0]
        resolved = "cuda" if "CUDA" in used else "dml" if "Dml" in used else "coreml" if "CoreML" in used else "cpu"
        self.info = ModelInfo(id=f"{repo.split('/')[-1]}@1", dim=int(dim), device=resolved, providers=list(self.vision.get_providers()))

    @staticmethod
    def _preprocess(data: bytes) -> np.ndarray:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        w, h = img.size
        s = SIZE / min(w, h)
        img = img.resize((max(SIZE, round(w * s)), max(SIZE, round(h * s))), Image.BICUBIC)
        w, h = img.size
        left, top = (w - SIZE) // 2, (h - SIZE) // 2
        img = img.crop((left, top, left + SIZE, top + SIZE))
        arr = (np.asarray(img, dtype=np.float32) / 255.0 - MEAN) / STD
        return arr.transpose(2, 0, 1)

    @staticmethod
    def _normalize(x: np.ndarray) -> np.ndarray:
        return x / np.clip(np.linalg.norm(x, axis=1, keepdims=True), 1e-12, None)

    def embed_images(self, images: list[bytes]) -> np.ndarray:
        batch = np.stack([self._preprocess(b) for b in images]).astype(np.float32)
        return self._normalize(self.vision.run(None, {"pixel_values": batch})[0])

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        enc = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        return self._normalize(self.text.run(None, {"input_ids": ids})[0])
