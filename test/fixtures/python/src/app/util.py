def format_duration(ms):
    seconds = ms // 1000
    minutes = seconds // 60
    if minutes > 0:
        return str(minutes) + "m " + str(seconds % 60) + "s"
    return str(seconds) + "s"


def pretty_time(milliseconds):
    secs = milliseconds // 1000
    mins = secs // 60
    if mins > 0:
        return str(mins) + "m " + str(secs % 60) + "s"
    return str(secs) + "s"


def never_called_anywhere(a, b):
    total = a + b
    scaled = total * 2
    return scaled - 1
