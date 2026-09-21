import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memorylane_ai.main import app

FIXTURES = Path(__file__).parent / "fixtures"
NAMES = ["lincoln1.jpg", "lincoln2.jpg", "douglass1.jpg", "douglass2.jpg"]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def portraits(client):
    files = [("files", (n, (FIXTURES / n).read_bytes(), "image/jpeg")) for n in NAMES]
    r = client.post("/v1/faces", files=files)
    assert r.status_code == 200
    return r.json()


def test_health_reports_face_models(client):
    body = client.get("/v1/health").json()
    assert body["models"]["faces"] == {"id": "yunet-sface@1", "dim": 128}
    names = {m["name"]: m for m in body["face_models"]}
    assert names["yunet-sface"]["id"] == "yunet-sface@1" and names["buffalo_l"]["dim"] == 512
    r = client.post("/v1/faces", files=[("files", ("x.jpg", (FIXTURES / "lincoln1.jpg").read_bytes(), "image/jpeg"))], data={"model": "nope"})
    assert r.status_code == 400


def test_one_face_per_portrait(portraits):
    assert portraits["model"] == "yunet-sface@1" and portraits["dim"] == 128
    for image in portraits["images"]:
        assert len(image) == 1
        f = image[0]
        assert f["det_score"] > 0.8
        x, y, w, h = f["bbox"]
        assert 0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.001 and y + h <= 1.001
        assert len(f["landmarks"]) == 5
        assert abs(np.linalg.norm(f["embedding"]) - 1) < 1e-4


def test_identity_separation(portraits):
    e = np.array([img[0]["embedding"] for img in portraits["images"]])
    sims = e @ e.T
    assert sims[0, 1] > 0.55 and sims[2, 3] > 0.55  # same person
    assert sims[0, 2] < 0.3 and sims[0, 3] < 0.3 and sims[1, 2] < 0.3 and sims[1, 3] < 0.3  # different people


def test_cluster_groups_people(client, portraits):
    e = [img[0]["embedding"] for img in portraits["images"]]
    r = client.post("/v1/cluster", json={"vectors": e, "threshold": 0.5, "min_cluster_size": 2})
    assert r.status_code == 200
    labels = r.json()["labels"]
    assert labels[0] == labels[1] and labels[2] == labels[3] and labels[0] != labels[2]
    assert set(labels) == {0, 1}
    lonely = client.post("/v1/cluster", json={"vectors": e, "threshold": 0.5, "min_cluster_size": 3}).json()["labels"]
    assert lonely == [-1, -1, -1, -1]


def test_blank_image_has_no_faces_and_bad_dims_rejected(client):
    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (200, 200, 200)).save(buf, format="JPEG")
    r = client.post("/v1/faces", files=[("files", ("blank.jpg", buf.getvalue(), "image/jpeg"))])
    assert r.status_code == 200 and r.json()["images"] == [[]]
    assert client.post("/v1/cluster", json={"vectors": [[1, 0], [1, 0, 0]]}).status_code == 422
