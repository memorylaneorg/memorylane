import io
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memorylane_ai.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def jpeg(color, size=(320, 240)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def test_health(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["models"]["image_embed"]["dim"] == 512
    assert body["models"]["image_embed"]["id"] == "clip-vit-base-patch32@1"


def test_embed_images_shape_and_norm(client):
    r = client.post(
        "/v1/embed/image",
        files=[("files", ("a.jpg", jpeg((220, 30, 30)), "image/jpeg")), ("files", ("b.jpg", jpeg((30, 30, 220)), "image/jpeg"))],
    )
    assert r.status_code == 200
    v = np.array(r.json()["vectors"])
    assert v.shape == (2, 512)
    assert all(math.isclose(float(np.linalg.norm(row)), 1.0, abs_tol=1e-4) for row in v)
    assert r.json()["model"] == "clip-vit-base-patch32@1"


def test_text_matches_image(client):
    img = np.array(client.post("/v1/embed/image", files=[("files", ("r.jpg", jpeg((220, 30, 30)), "image/jpeg"))]).json()["vectors"][0])
    txt = np.array(client.post("/v1/embed/text", json={"texts": ["a red square", "a photo of a dog"]}).json()["vectors"])
    sims = txt @ img
    assert sims[0] > sims[1]


def test_rejects_bad_image_and_empty_batch(client):
    assert client.post("/v1/embed/image", files=[("files", ("x.jpg", b"not an image", "image/jpeg"))]).status_code == 422
    assert client.post("/v1/embed/text", json={"texts": []}).status_code == 422


def test_vector_store_lifecycle(client):
    space = "test:contract"
    rows = [{"id": 1, "vector": [1.0, 0.0]}, {"id": 2, "vector": [0.0, 1.0]}]
    assert client.post("/v1/vectors/clear", json={"space": space}).status_code == 200
    assert client.post("/v1/vectors/upsert", json={"space": space, "rows": rows}).status_code == 200
    assert client.get("/v1/vectors/count", params={"space": space}).json() == {"count": 2}
    hits = client.post("/v1/vectors/search", json={"space": space, "vector": [0.9, 0.1], "limit": 2, "exclude_ids": []}).json()["hits"]
    assert [hit["id"] for hit in hits] == [1, 2]
    assert client.post("/v1/vectors/remove", json={"space": space, "ids": [1]}).status_code == 200
    assert client.get("/v1/vectors/count", params={"space": space}).json() == {"count": 1}
