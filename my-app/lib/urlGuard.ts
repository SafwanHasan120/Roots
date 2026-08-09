import { promises as dns } from 'dns';
import { URL } from 'url';

// Private IP ranges (IPv4 and IPv6) that should be rejected
const PRIVATE_IPV6_PREFIXES = [
  '::1', // loopback
  'fe80::', // link-local
  'fc00::', // unique-local
  'fd00::', // unique-local
];

function isInRange(ip: string, min: string, max: string): boolean {
  const ipParts = ip.split('.').map(Number);
  const minParts = min.split('.').map(Number);
  const maxParts = max.split('.').map(Number);

  if (ipParts.length !== 4 || minParts.length !== 4 || maxParts.length !== 4) {
    return false;
  }

  for (let i = 0; i < 4; i++) {
    if (ipParts[i] < minParts[i]) return false;
    if (ipParts[i] > maxParts[i]) return false;
    if (ipParts[i] > minParts[i] && ipParts[i] < maxParts[i]) return true;
  }

  return true;
}

function isPrivateIPv4(ip: string): boolean {
  // 10.0.0.0/8
  if (isInRange(ip, '10.0.0.0', '10.255.255.255')) return true;
  // 172.16.0.0/12
  if (isInRange(ip, '172.16.0.0', '172.31.255.255')) return true;
  // 192.168.0.0/16
  if (isInRange(ip, '192.168.0.0', '192.168.255.255')) return true;
  // 127.0.0.0/8 (loopback)
  if (isInRange(ip, '127.0.0.0', '127.255.255.255')) return true;
  // 169.254.0.0/16 (link-local)
  if (isInRange(ip, '169.254.0.0', '169.254.255.255')) return true;

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalizedIp = ip.toLowerCase();

  // Check for loopback
  if (normalizedIp === '::1') return true;

  // Check for link-local (fe80::/10)
  if (normalizedIp.startsWith('fe80:')) return true;

  // Check for unique-local (fc00::/7)
  if (normalizedIp.startsWith('fc') || normalizedIp.startsWith('fd')) return true;

  return false;
}

export async function assertSafeUrl(urlString: string): Promise<void> {
  // 1. Validate URL format and scheme
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  // 2. Resolve hostname to IP
  const hostname = url.hostname;
  let resolvedIps: string[];

  try {
    resolvedIps = await dns.resolve4(hostname).catch(() =>
      dns.resolve6(hostname)
    );
  } catch {
    throw new Error(`Cannot resolve hostname: ${hostname}`);
  }

  if (!resolvedIps || resolvedIps.length === 0) {
    throw new Error(`Cannot resolve hostname: ${hostname}`);
  }

  // 3. Check each resolved IP for private ranges
  for (const ip of resolvedIps) {
    if (ip.includes(':')) {
      // IPv6
      if (isPrivateIPv6(ip)) {
        throw new Error(`Resolved IP is private (IPv6): ${ip}`);
      }
    } else {
      // IPv4
      if (isPrivateIPv4(ip)) {
        throw new Error(`Resolved IP is private (IPv4): ${ip}`);
      }
    }
  }
}
