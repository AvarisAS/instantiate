/**
 * An error caused by how the tool was invoked, not by a defect in it.
 *
 * These print their message and nothing else. Anything that is not one of these
 * gets a stack trace and a link to report it, because a bare one-line failure
 * leaves a user with nothing to act on and leaves us with nothing to debug.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
