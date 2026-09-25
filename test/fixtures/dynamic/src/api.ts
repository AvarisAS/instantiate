type Verb = 'get' | 'post';

export class Api {
  get(): string {
    return 'got';
  }
  post(): string {
    return 'posted';
  }
  purge(): string {
    return 'never called by anyone at all';
  }
  call(verb: Verb): string {
    return this[verb]();
  }
}
