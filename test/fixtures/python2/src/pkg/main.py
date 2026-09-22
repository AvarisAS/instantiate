from .base import LoudRunner, make_decorator


@make_decorator()
def entry():
    return LoudRunner().run("hello world")


if __name__ == "__main__":
    print(entry())
