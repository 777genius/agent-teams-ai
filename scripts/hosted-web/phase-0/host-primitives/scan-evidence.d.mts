export interface EvidenceScanResult {
  failures: string[];
  ok: boolean;
}

export function verifyW4Handoff(root?: string): Promise<EvidenceScanResult>;
export function scanEvidence(directory: string): Promise<EvidenceScanResult>;
