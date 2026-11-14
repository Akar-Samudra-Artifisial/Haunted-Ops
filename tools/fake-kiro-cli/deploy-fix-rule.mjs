// The rule of `POST /chaos/deploy-fix` of the lab (contract of `fix-proposal-flow`; the lab implements it in `fix-deploy`).
// Pure, so the fake lab route and the property test share it.

export const SERVICE_NAMES = ['gate', 'orders', 'payments', 'ledger'];
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const INCIDENT_REF = /^incident\/[a-z0-9]{20,32}$/;

/** Checks the body of the request: exactly `{ service, ref, sha }`. */
export function parseDeployFixBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'ref,service,sha') return null;
  const { service, ref, sha } = body;
  if (!SERVICE_NAMES.includes(service) || typeof ref !== 'string' || !INCIDENT_REF.test(ref) || typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
  return { service, ref, sha };
}

/**
 * True when `sha` may be deployed for `service`: it is the head of the ref, and walking the first parents from it
 * reaches the head of an allow-listed branch (`main` or a scenario head) through commits that touch only
 * `services/<service>/`.
 *
 * `chain` lists the first-parent commits from the head down: `[{ sha, files }, ...]`. A commit that is itself an
 * allowed head ends the walk and is not judged. A chain that ends without reaching one is refused.
 */
export function deployFixAllowed({ head, sha, chain, allowedHeads, service }) {
  if (!SERVICE_NAMES.includes(service)) return false;
  if (typeof head !== 'string' || typeof sha !== 'string' || head !== sha) return false;
  if (!Array.isArray(chain) || chain.length === 0 || chain[0]?.sha !== sha) return false;
  const prefix = `services/${service}/`;
  for (const commit of chain) {
    if (allowedHeads.includes(commit.sha)) return true;
    if (!Array.isArray(commit.files) || !commit.files.every((f) => typeof f === 'string' && f.startsWith(prefix))) return false;
  }
  return false;
}
