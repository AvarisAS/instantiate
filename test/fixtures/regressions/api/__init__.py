import os


def _read_local_env():
    os.environ.setdefault("MODE", "local")


# Runs whenever anything in the package is imported.
_read_local_env()
