/**
 * HubError: expected failures (unknown/offline/paused/busy agents, rate
 * limits). Tools translate these into error results instead of crashing;
 * anything else is a bug.
 */
export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
