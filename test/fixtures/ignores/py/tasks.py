def run():
    return 1


# instantiate-ignore dead: the scheduler imports this by dotted path
def nightly():
    return 2


def forgotten():
    return 3


if __name__ == "__main__":
    run()
