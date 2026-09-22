from . import helpers


class Runner:
    def run(self, text):
        return self.format(text)

    def format(self, text):
        raise NotImplementedError


class LoudRunner(Runner):
    def format(self, text):
        # An override: nothing names it, but `self.format()` in the base runs it.
        return helpers.shorten(text).upper()


def make_decorator():
    def decorator(fn):
        # A nested function: not a symbol, but its calls still count.
        register(fn)
        return fn

    return decorator


def register(fn):
    return fn


def never_used_at_all(a, b):
    total = a + b
    doubled = total * 2
    return doubled - 1
