/**
 * Terminal errors of a protected operation. Readlace has no accounts any
 * more (ADR 0020), so these no longer mean a signed-out session: work is
 * retired when its local generation ends. The codes stay stable because
 * runtime messages carry them as JSON terminal codes, never message text.
 */
export class AuthUnavailableError extends Error {
  readonly code = "AUTH_UNAVAILABLE";
  readonly retryable = false;

  constructor() {
    super("Readlace could not start this work. Try again.");
    this.name = "AuthUnavailableError";
  }
}

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  readonly status = 401;
  readonly retryable = false;

  constructor() {
    super("This work was stopped. Try again.");
    this.name = "AuthRequiredError";
  }
}
