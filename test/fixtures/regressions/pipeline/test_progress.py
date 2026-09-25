from pipeline.progress import (
    Progress,
)


def test_new_progress_is_pending():
    progress = Progress(stages=[])
    assert progress.overall == "pending"
