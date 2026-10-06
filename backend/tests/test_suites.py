"""The test entry point: `pytest` from backend/.

Each verify_*.py script is an end-to-end suite: it starts the real API on a
throwaway database, exercises it the way a user or an agent would, and exits
non-zero if any check fails. Each runs in its own process, so every suite
gets a fresh database and settings. A static check keeps the code free of
undefined names and unused imports."""
from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).parent
BACKEND = HERE.parent
SUITES = sorted(HERE.glob("verify_*.py"))


@pytest.mark.parametrize("script", SUITES, ids=lambda p: p.stem)
def test_suite(script: pathlib.Path) -> None:
    run = subprocess.run([sys.executable, str(script)], cwd=BACKEND, capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=1200)
    failed = [line for line in run.stdout.splitlines() if line.lstrip().startswith("FAIL")]
    assert run.returncode == 0, "\n".join(failed) or (run.stdout[-3000:] + run.stderr[-3000:])


def test_static() -> None:
    run = subprocess.run([sys.executable, "-m", "pyflakes", "app", "tests", "tools"], cwd=BACKEND,
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
