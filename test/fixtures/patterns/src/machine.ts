export class Machine {
  start(): string {
    return this.#privateStep();
  }
  #privateStep(): string {
    return 'stepped';
  }
}
