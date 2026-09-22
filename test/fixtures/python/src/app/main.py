from .service import Reporter


def run():
    reporter = Reporter()
    print(reporter.report(1234))


if __name__ == "__main__":
    run()
