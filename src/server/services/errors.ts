/**
 * Service-layer errors. Adapters (MCP tools, REST routes) map these to their
 * protocol-specific error shapes; `code` is stable.
 */
export class ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string) {
    super("validation_error", message);
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super("not_found", message);
  }
}

export interface Candidate {
  id: number;
  label: string;
}

export class AmbiguousError extends ServiceError {
  readonly candidates: Candidate[];

  constructor(message: string, candidates: Candidate[]) {
    const listed = candidates.map((c) => `#${c.id} "${c.label}"`).join(", ");
    super("ambiguous", `${message} Candidates: ${listed}`);
    this.candidates = candidates;
  }
}
