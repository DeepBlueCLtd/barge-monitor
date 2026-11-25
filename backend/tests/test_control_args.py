"""Switch actions take {"on": bool} from the shell (§13.3); a dict is not truthy by itself."""
from barge.runtime import _on


def test_switch_argument_is_read_not_truth_tested():
    assert _on({"on": False}) is False
    assert _on({"on": True}) is True
    assert _on(False) is False and _on(True) is True and _on(None) is False
