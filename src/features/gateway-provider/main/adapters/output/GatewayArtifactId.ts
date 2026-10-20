import crypto from 'node:crypto';

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21);
}

/** Globally unique OpenCode provider id for one gateway usage source. */
export function toGatewayArtifactId(input: {
  teamName: string;
  memberName: string;
  gatewayUsageRef: string;
}): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([input.teamName, input.memberName, input.gatewayUsageRef]), 'utf8')
    .digest('hex')
    .slice(0, 12);
  const team = sanitizeSegment(input.teamName) || 'team';
  const member = sanitizeSegment(input.memberName) || 'member';
  return `gateway-${team}-${member}-${hash}`;
}
