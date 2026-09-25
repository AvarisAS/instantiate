from abc import ABC, abstractmethod


class Store(ABC):
    @abstractmethod
    def save(self, item):
        raise NotImplementedError

    def load(self, key):
        raise NotImplementedError


class DiskStore(Store):
    def save(self, item):
        return item

    def load(self, key):
        return key


def compress(data):
    """Shrink the payload."""
    raise NotImplementedError("compression lands next sprint")


def migrate():
    # TODO: move rows to the new schema
    pass


def reserved():
    pass
