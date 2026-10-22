import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_core_node_suite():
    r = subprocess.run(["node", "--test", "tests/core.test.js"], cwd=ROOT, capture_output=True, text=True)
    print(r.stdout[-4000:], r.stderr[-2000:])
    assert r.returncode == 0
