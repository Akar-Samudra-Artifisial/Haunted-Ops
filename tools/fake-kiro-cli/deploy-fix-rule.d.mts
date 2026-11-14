export const SERVICE_NAMES: string[];
export const FULL_SHA: RegExp;
export const INCIDENT_REF: RegExp;
export interface DeployFixBody {
  service: string;
  ref: string;
  sha: string;
}
export function parseDeployFixBody(body: unknown): DeployFixBody | null;
export interface ChainCommit {
  sha: string;
  files: string[];
}
export function deployFixAllowed(input: { head: string; sha: string; chain: ChainCommit[]; allowedHeads: string[]; service: string }): boolean;
