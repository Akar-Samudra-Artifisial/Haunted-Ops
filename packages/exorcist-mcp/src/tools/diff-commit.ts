import { LIMITS, type ToolInputs } from '../schemas.js';
import { clean, cutBytes, envelope, errorEnvelope, shrinkText } from '../untrusted.js';
import { FULL_SHA, short, type ToolRun } from './context.js';

export const diffCommit: ToolRun<ToolInputs['diff_commit']> = async (input, ctx) => {
  const r = await ctx.lab.diff(input.sha);
  if (!r.ok) return errorEnvelope('diff_commit', r.code);
  const d = r.value;
  if (typeof d.sha !== 'string' || !FULL_SHA.test(d.sha) || !d.sha.startsWith(input.sha)) return errorEnvelope('diff_commit', 'lab_error');
  const full = clean(d.diff, LIMITS.diffBytes * 4, true);
  const diff = cutBytes(full, LIMITS.diffBytes);
  const subject = clean(d.subject, LIMITS.subject);
  const { handle } = ctx.handles.issue(
    { kind: 'commit', sha: d.sha },
    { tool: 'diff_commit', service: null, deployId: null, sha: d.sha, detail: clean(`commit ${short(d.sha)}: ${subject}`, LIMITS.detail) },
  );
  const data = {
    handle,
    sha: d.sha,
    subject,
    author: clean(d.author, LIMITS.author),
    date: clean(d.date, 40),
    diff,
    bytes: typeof d.bytes === 'number' && Number.isFinite(d.bytes) ? d.bytes : Buffer.byteLength(full, 'utf8'),
  };
  const truncated = d.truncated === true || diff.length < full.length;
  return envelope('diff_commit', 'lab', data, truncated, shrinkText('diff'), ctx.secrets);
};
