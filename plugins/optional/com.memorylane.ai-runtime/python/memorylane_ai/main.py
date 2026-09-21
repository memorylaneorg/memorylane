from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field
import os
import sqlite3
import threading
import numpy as np

from .clip_model import ClipModel, _providers
from .cluster import chinese_whispers
from .config import Settings
from .face_model import FACE_MODELS, FaceModel, create_face_model, face_model_id

settings = Settings()
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="memorylane-ai", lifespan=lifespan)


def require_token(authorization: str | None = Header(default=None)) -> None:
    if settings.token and authorization != f"Bearer {settings.token}":
        raise HTTPException(status_code=401, detail="Invalid or missing token")


class TextRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class ClusterRequest(BaseModel):
    vectors: list[list[float]] = Field(min_length=1, max_length=200_000)
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    min_cluster_size: int = Field(default=3, ge=1)
    iterations: int = Field(default=20, ge=1, le=100)

class VectorRow(BaseModel):
    id: int = Field(gt=0)
    vector: list[float] = Field(min_length=1, max_length=65536)

class VectorUpsertRequest(BaseModel):
    space: str = Field(min_length=1, max_length=300)
    rows: list[VectorRow] = Field(min_length=1, max_length=5000)

class VectorIdsRequest(BaseModel):
    space: str = Field(min_length=1, max_length=300)
    ids: list[int] = Field(min_length=1, max_length=10000)

class VectorSearchRequest(BaseModel):
    space: str = Field(min_length=1, max_length=300)
    vector: list[float] = Field(min_length=1, max_length=65536)
    limit: int = Field(ge=1, le=1000)
    exclude_ids: list[int] = Field(default_factory=list, max_length=10000)

class VectorSpaceRequest(BaseModel):
    space: str = Field(min_length=1, max_length=300)

os.makedirs(settings.data_dir, exist_ok=True)
vectors_db = sqlite3.connect(os.path.join(settings.data_dir, "vectors.sqlite"), check_same_thread=False)
vectors_db.execute("CREATE TABLE IF NOT EXISTS vectors(space TEXT NOT NULL, id INTEGER NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(space,id))")
vectors_db.commit()
vectors_lock = threading.Lock()


def model() -> ClipModel:
    if "model" not in state:
        state["model"] = ClipModel(settings.model_repo, settings.device)
    return state["model"]


# Loaded on first use so CLIP-only setups keep their fast startup; the
# detector download is ~38 MB.
FACE_ID, FACE_DIM_ACTIVE = face_model_id(settings.face_model)


# Any known face model can be requested per call (Settings › People picks
# one); each loads lazily on first use and stays resident.
def face_model(name: str | None = None) -> FaceModel:
    name = name or settings.face_model
    if name not in FACE_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown face model '{name}'")
    key = f"faces:{name}"
    if key not in state:
        state[key] = create_face_model(name, _providers(settings.device))
    return state[key]


@app.get("/v1/health")
def health(_: None = Depends(require_token)):
    loaded = state.get("model")
    info = loaded.info if loaded else type("Info", (), {"id": f"{settings.model_repo.split('/')[-1]}@1", "dim": 512, "device": settings.device, "providers": _providers(settings.device)})()
    return {
        "status": "ready",
        "pluginId": os.environ.get("MEMORYLANE_PLUGIN_ID", "com.memorylane.ai-runtime"),
        "version": os.environ.get("MEMORYLANE_PLUGIN_VERSION", "1.0.0"),
        "pluginApi": int(os.environ.get("MEMORYLANE_PLUGIN_API", "1")),
        "ok": True,
        "device": info.device,
        "providers": info.providers,
        "max_batch": settings.max_batch,
        "models": {
            "image_embed": {"id": info.id, "dim": info.dim},
            "text_embed": {"id": info.id, "dim": info.dim},
            "faces": {"id": FACE_ID, "dim": FACE_DIM_ACTIVE},
        },
        "face_models": [{"name": n, **m} for n, m in FACE_MODELS.items()],
    }


@app.post("/shutdown")
def shutdown(_: None = Depends(require_token)):
    threading.Timer(0.1, lambda: os._exit(0)).start()
    return {"ok": True}


@app.post("/v1/embed/image")
async def embed_image(files: list[UploadFile] = File(...), _: None = Depends(require_token)):
    if not 1 <= len(files) <= settings.max_batch:
        raise HTTPException(status_code=400, detail=f"Send between 1 and {settings.max_batch} files")
    data = [await f.read() for f in files]
    try:
        vectors = model().embed_images(data)
    except Exception as exc:  # undecodable image etc. - the caller's problem, not an outage
        raise HTTPException(status_code=422, detail=f"Could not process an image: {exc}") from exc
    info = model().info
    return {"model": info.id, "dim": info.dim, "vectors": vectors.tolist()}


@app.post("/v1/embed/text")
def embed_text(req: TextRequest, _: None = Depends(require_token)):
    vectors = model().embed_texts(req.texts)
    info = model().info
    return {"model": info.id, "dim": info.dim, "vectors": vectors.tolist()}


@app.post("/v1/faces")
async def faces(files: list[UploadFile] = File(...), model: str | None = Form(default=None), _: None = Depends(require_token)):
    if not 1 <= len(files) <= 16:
        raise HTTPException(status_code=400, detail="Send between 1 and 16 files")
    data = [await f.read() for f in files]
    name = model or settings.face_model
    if name not in FACE_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown face model '{name}'")
    model_id, dim = face_model_id(name)
    try:
        fm = face_model(name)
    except Exception as exc:  # model download/load failure is an outage, not a bad request
        raise HTTPException(status_code=503, detail=f"Face model unavailable: {exc}") from exc
    try:
        results = fm.detect_and_embed(data)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not process an image: {exc}") from exc
    return {
        "model": model_id,
        "dim": dim,
        "images": [
            [{"bbox": f.bbox, "landmarks": f.landmarks, "det_score": f.det_score, "embedding": f.embedding.tolist()} for f in image]
            for image in results
        ],
    }


@app.post("/v1/cluster")
def cluster(req: ClusterRequest, _: None = Depends(require_token)):
    dims = {len(v) for v in req.vectors}
    if len(dims) != 1:
        raise HTTPException(status_code=422, detail="All vectors must have the same length")
    labels = chinese_whispers(np.asarray(req.vectors, dtype=np.float32), req.threshold, req.min_cluster_size, req.iterations)
    return {"labels": labels}

@app.post("/v1/vectors/upsert")
def vectors_upsert(req: VectorUpsertRequest, _: None = Depends(require_token)):
    dims = {len(row.vector) for row in req.rows}
    if len(dims) != 1: raise HTTPException(status_code=422, detail="All vectors must have the same length")
    with vectors_lock, vectors_db:
        vectors_db.executemany("INSERT INTO vectors(space,id,dim,vector) VALUES(?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET dim=excluded.dim,vector=excluded.vector", [(req.space,r.id,len(r.vector),np.asarray(r.vector,dtype=np.float32).tobytes()) for r in req.rows])
    return {"ok": True}

@app.post("/v1/vectors/remove")
def vectors_remove(req: VectorIdsRequest, _: None = Depends(require_token)):
    with vectors_lock, vectors_db: vectors_db.executemany("DELETE FROM vectors WHERE space=? AND id=?", [(req.space,i) for i in req.ids])
    return {"ok": True}

@app.post("/v1/vectors/search")
def vectors_search(req: VectorSearchRequest, _: None = Depends(require_token)):
    query = np.asarray(req.vector, dtype=np.float32)
    excluded = set(req.exclude_ids)
    with vectors_lock:
        rows = [(row_id, blob) for row_id, blob in vectors_db.execute(
            "SELECT id,vector FROM vectors WHERE space=? AND dim=?", (req.space, len(query))
        ) if row_id not in excluded]
    if not rows:
        return {"hits": []}
    matrix = np.frombuffer(b"".join(blob for _, blob in rows), dtype=np.float32).reshape(len(rows), len(query))
    scores = matrix @ query / np.maximum(np.linalg.norm(matrix, axis=1) * max(float(np.linalg.norm(query)), 1e-12), 1e-12)
    count = min(req.limit, len(rows))
    indexes = np.argpartition(scores, -count)[-count:]
    indexes = indexes[np.argsort(scores[indexes])[::-1]]
    return {"hits": [{"id": rows[int(i)][0], "score": float(scores[int(i)])} for i in indexes]}

@app.get("/v1/vectors/count")
def vectors_count(space: str, _: None = Depends(require_token)):
    with vectors_lock:
        count = vectors_db.execute("SELECT COUNT(*) FROM vectors WHERE space=?",(space,)).fetchone()[0]
    return {"count": count}

@app.post("/v1/vectors/clear")
def vectors_clear(req: VectorSpaceRequest, _: None = Depends(require_token)):
    with vectors_lock, vectors_db:
        vectors_db.execute("DELETE FROM vectors WHERE space=?", (req.space,))
    return {"ok": True}
