# SPDX-License-Identifier: Apache-2.0
"""SDK kernel micro-benchmark: the Rust RAG kernels of `aphrody.aphrody_rust` against NumPy, on the interpreter that
runs it (best of 7 runs, in-process). Run it with each arm's interpreter; it prints one JSON object.

    <env>/bin/python scripts/bench-kernels.py [rows] [dimensions]
"""

import json
import sys
import time

import numpy as np
from aphrody import aphrody_rust as rust

rows = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
dim = int(sys.argv[2]) if len(sys.argv) > 2 else 384
rng = np.random.default_rng(7)
data = rng.standard_normal((rows, dim), dtype=np.float32)
raw = data.tobytes()
query = data[0].tobytes()


def best(function, runs=7):
    times = []
    for _ in range(runs):
        start = time.perf_counter()
        function()
        times.append((time.perf_counter() - start) * 1000)
    return min(times)


def numpy_normalize():
    return data / np.maximum(np.linalg.norm(data, axis=1, keepdims=True), 1e-12)


def numpy_similarities():
    unit = numpy_normalize()
    return unit @ unit[0]


report = {
    "python": sys.version.split()[0],
    "numpy": np.__version__,
    "shape": [rows, dim],
    "normalize_ms": {
        "rust": best(lambda: rust.normalize_embeddings_f32(raw, rows, dim)),
        "numpy": best(numpy_normalize),
    },
    "similarities_ms": {
        "rust": best(lambda: rust.embedding_similarities_f32(raw, query, rows, 1, dim)),
        "numpy": best(numpy_similarities),
    },
}
print(json.dumps(report))
