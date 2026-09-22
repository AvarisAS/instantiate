from .util import format_duration


class Reporter:
    def report(self, ms):
        return self._decorate(format_duration(ms))

    def _decorate(self, text):
        return "[" + text + "]"

    def unused_method(self):
        return "nobody calls me"
