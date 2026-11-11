"""Runs the NouGenTube extension's node tests (stream stall deadlines) when node is available."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEST_FILE = ROOT / "extensions" / "nougentube-chrome" / "tests" / "background-stall.test.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_stream_deadlines_cover_the_whole_answer():
    result = subprocess.run(
        ["node", "--test", str(TEST_FILE)], capture_output=True, text=True, timeout=120, check=False
    )
    assert result.returncode == 0, result.stdout[-2500:] + result.stderr[-1500:]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_morph_core_checks_the_21_steps_and_citations():
    test_file = ROOT / "extensions" / "nougentube-chrome" / "tests" / "morph-core.test.mjs"
    result = subprocess.run(
        ["node", "--test", str(test_file)], capture_output=True, text=True, timeout=120, check=False
    )
    assert result.returncode == 0, result.stdout[-2500:] + result.stderr[-1500:]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_bridge_ports_settle_when_the_panel_goes_away():
    test_file = ROOT / "extensions" / "nougentube-chrome" / "tests" / "background-ports.test.mjs"
    result = subprocess.run(
        ["node", "--test", str(test_file)], capture_output=True, text=True, timeout=120, check=False
    )
    assert result.returncode == 0, result.stdout[-2500:] + result.stderr[-1500:]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_auto_theme_follows_youtube_then_the_system():
    test_file = ROOT / "extensions" / "nougentube-chrome" / "tests" / "theme-core.test.mjs"
    result = subprocess.run(
        ["node", "--test", str(test_file)], capture_output=True, text=True, timeout=120, check=False
    )
    assert result.returncode == 0, result.stdout[-2500:] + result.stderr[-1500:]
