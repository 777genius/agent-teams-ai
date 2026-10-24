/** Application routing IDs only; the Host remains the sole outcome/custody owner. */
export interface TeamModelProbeIntents {
  read(rootId: string, preparationId: string): Promise<{ commandId: string; retained: boolean }>;
  /** Called after reading the original Host outcome. Renewal requires known released terminal evidence. */
  admit(
    rootId: string,
    preparationId: string,
    previousCommandId: string,
    renew: boolean
  ): Promise<string>;
}
