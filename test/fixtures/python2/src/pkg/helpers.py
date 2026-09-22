DEFAULT_WIDTH = 80


def shorten(text, width=DEFAULT_WIDTH):
    if len(text) <= width:
        return text
    return text[: width - 1] + "-"
