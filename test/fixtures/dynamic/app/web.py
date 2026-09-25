import importlib
from flask import Flask

from app.tasks import Tasks

def run(name):
    getattr(Tasks(), "refresh")()
    plugin = importlib.import_module(f"app.plugins.{name}")
    return getattr(plugin, name)


if __name__ == "__main__":
    run("csv")
