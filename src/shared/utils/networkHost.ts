export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true;
  }
  return parseIpv4Octets(normalized)?.[0] === 127;
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (normalized.endsWith('.local')) {
    return true;
  }
  if (normalized.includes(':')) {
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) ranges.
    return /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
  }
  const ipv4 = parseIpv4Octets(normalized);
  if (!ipv4) {
    return false;
  }
  return (
    ipv4[0] === 10 ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168) ||
    (ipv4[0] === 169 && ipv4[1] === 254)
  );
}

export function isUnusableNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '255.255.255.255') {
    return true;
  }
  if (normalized.startsWith('ff') && normalized.includes(':')) return true;
  const ipv4 = parseIpv4Octets(normalized);
  return ipv4 ? ipv4[0] >= 224 : false;
}

export function parseIpv4Octets(hostname: string): readonly number[] | null {
  const match = /^(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}))$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}
