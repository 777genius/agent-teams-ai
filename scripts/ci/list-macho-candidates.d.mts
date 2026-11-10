export interface MachOCandidates {
  regularFiles: number;
  candidates: string[];
}
export function listMachOCandidates(root: string): MachOCandidates;
