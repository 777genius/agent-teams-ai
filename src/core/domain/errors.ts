export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

export class RuntimeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInvariantError";
  }
}

export class BoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryViolationError";
  }
}
