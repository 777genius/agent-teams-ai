export interface MemberWorkSyncHttpIdentifierValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

export interface MemberWorkSyncHttpIdentifierValidationPort {
  validateTeamName(value: unknown): MemberWorkSyncHttpIdentifierValidationResult;
  validateMemberName(value: unknown): MemberWorkSyncHttpIdentifierValidationResult;
}

export interface MemberWorkSyncHttpClockPort {
  now(): Date;
}

export interface MemberWorkSyncHttpLoggerPort {
  error(message: string, detail: string): void;
}

export interface MemberWorkSyncHttpUnexpectedErrorMapping {
  statusCode: number;
  responseMessage: string;
  shouldLog: boolean;
  logMessage: string;
}

export interface MemberWorkSyncHttpUnexpectedErrorPort {
  map(error: unknown): MemberWorkSyncHttpUnexpectedErrorMapping;
}

export interface MemberWorkSyncHttpHostPorts {
  identifiers: MemberWorkSyncHttpIdentifierValidationPort;
  clock: MemberWorkSyncHttpClockPort;
  logger: MemberWorkSyncHttpLoggerPort;
  unexpectedErrors: MemberWorkSyncHttpUnexpectedErrorPort;
}
