/** Errors a read can raise that are the caller's to fix (a missing query, a bad regex or cursor). */

export class SectionNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionNotFound";
  }
}

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}
