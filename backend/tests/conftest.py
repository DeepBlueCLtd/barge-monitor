import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(scope="session")
def data_folder(tmp_path_factory) -> Path:
    """The data folder, generated once per session from its seeds (FR-15), as the site build writes it."""
    from barge.datafolder import build, gz

    out = tmp_path_factory.mktemp("data-folder")
    for name, data in build().items():
        (out / (name if name == "index.json" else name + ".gz")).write_bytes(data if name == "index.json" else gz(data))
    return out


@pytest.fixture
def folder_copy(data_folder, tmp_path) -> Path:
    """A private copy of the data folder, for a test that adds or changes files in it."""
    out = tmp_path / "folder"
    shutil.copytree(data_folder, out)
    return out
