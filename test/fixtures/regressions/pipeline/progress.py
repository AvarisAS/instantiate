from dataclasses import dataclass


@dataclass
class Progress:
    stages: list

    @property
    def overall(self):
        return "done" if self.stages else "pending"
