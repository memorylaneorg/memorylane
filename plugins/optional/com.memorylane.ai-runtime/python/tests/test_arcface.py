"""Opt-in ArcFace (buffalo_l) checks - downloads ~190 MB, so only runs when
MEMORYLANE_AI_TEST_ARCFACE=1 is set."""
import os
from pathlib import Path

import numpy as np
import pytest

from memorylane_ai.face_model import ArcFaceModel, face_model_id

FIXTURES = Path(__file__).parent / "fixtures"
pytestmark = pytest.mark.skipif(not os.environ.get("MEMORYLANE_AI_TEST_ARCFACE"), reason="set MEMORYLANE_AI_TEST_ARCFACE=1")


def test_model_ids():
    assert face_model_id("buffalo_l") == ("buffalo_l@1", 512)
    assert face_model_id("yunet-sface") == ("yunet-sface@1", 128)
    with pytest.raises(ValueError):
        face_model_id("nope")


def test_arcface_separates_identities():
    m = ArcFaceModel(["CPUExecutionProvider"])
    results = m.detect_and_embed([(FIXTURES / n).read_bytes() for n in ["lincoln1.jpg", "lincoln2.jpg", "douglass1.jpg", "douglass2.jpg"]])
    assert all(len(r) == 1 for r in results)
    e = np.array([r[0].embedding for r in results])
    assert e.shape == (4, 512)
    sims = e @ e.T
    assert sims[0, 1] > 0.6 and sims[2, 3] > 0.55
    assert sims[0, 2] < 0.2 and sims[1, 3] < 0.2
