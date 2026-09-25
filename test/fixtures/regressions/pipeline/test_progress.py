from pipeline.progress import (
    Progress,
)


def test_new_state_is_pending():
    state = Progress(stages=[])
    assert state.overall == "pending"
