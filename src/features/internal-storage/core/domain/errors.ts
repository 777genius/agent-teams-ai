export class InternalStorageImportVerificationError extends Error {
  constructor(storeId: string, teamName: string) {
    super(
      `Imported ${storeId} rows for team "${teamName}" do not match the legacy JSON source; ` +
        'keeping the JSON file as the source of truth'
    );
    this.name = 'InternalStorageImportVerificationError';
  }
}

export class InternalStorageUnavailableError extends Error {
  constructor(reason: string) {
    super(`Internal storage backend unavailable: ${reason}`);
    this.name = 'InternalStorageUnavailableError';
  }
}
