import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as dns } from 'dns';
import { assertSafeUrl } from '../urlGuard';

vi.mock('dns');

describe('urlGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('assertSafeUrl', () => {
    it('should reject invalid URL format', async () => {
      await expect(assertSafeUrl('not a url')).rejects.toThrow('Invalid URL format');
    });

    it('should reject non-http schemes', async () => {
      await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow('Unsupported protocol');
      await expect(assertSafeUrl('gopher://example.com')).rejects.toThrow('Unsupported protocol');
      await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('Unsupported protocol');
    });

    it('should accept http and https schemes', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34'] as any);
      await expect(assertSafeUrl('https://example.com')).resolves.toBeUndefined();
    });

    it('should reject loopback IPv4 addresses', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['127.0.0.1'] as any);
      await expect(assertSafeUrl('http://localhost')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject private IPv4 addresses (10.0.0.0/8)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['10.0.0.1'] as any);
      await expect(assertSafeUrl('http://internal.local')).rejects.toThrow('Resolved IP is private');

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['10.255.255.255'] as any);
      await expect(assertSafeUrl('http://internal.local')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject private IPv4 addresses (172.16.0.0/12)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['172.16.0.1'] as any);
      await expect(assertSafeUrl('http://internal.local')).rejects.toThrow('Resolved IP is private');

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['172.31.255.255'] as any);
      await expect(assertSafeUrl('http://internal.local')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject private IPv4 addresses (192.168.0.0/16)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['192.168.0.1'] as any);
      await expect(assertSafeUrl('http://router.local')).rejects.toThrow('Resolved IP is private');

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['192.168.255.255'] as any);
      await expect(assertSafeUrl('http://router.local')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject link-local IPv4 addresses (169.254.0.0/16)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['169.254.0.1'] as any);
      await expect(assertSafeUrl('http://link-local.local')).rejects.toThrow('Resolved IP is private');

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['169.254.255.255'] as any);
      await expect(assertSafeUrl('http://link-local.local')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject loopback IPv6 addresses', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('No IPv4'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['::1'] as any);
      await expect(assertSafeUrl('http://localhost')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject link-local IPv6 addresses', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('No IPv4'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['fe80::1'] as any);
      await expect(assertSafeUrl('http://local.ipv6')).rejects.toThrow('Resolved IP is private');
    });

    it('should reject unique-local IPv6 addresses (fc00::/7)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('No IPv4'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['fc00::1'] as any);
      await expect(assertSafeUrl('http://private.ipv6')).rejects.toThrow('Resolved IP is private');

      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('No IPv4'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['fd00::1'] as any);
      await expect(assertSafeUrl('http://private.ipv6')).rejects.toThrow('Resolved IP is private');
    });

    it('should accept public IPv4 addresses', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['8.8.8.8'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['1.1.1.1'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();

      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();
    });

    it('should accept public IPv6 addresses', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('No IPv4'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['2001:4860:4860::8888'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();
    });

    it('should handle DNS resolution failure', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('ENOTFOUND'));
      vi.mocked(dns.resolve6).mockRejectedValueOnce(new Error('ENOTFOUND'));
      await expect(assertSafeUrl('http://nonexistent.invalid')).rejects.toThrow('Cannot resolve hostname');
    });

    it('should handle empty DNS response', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce([] as any);
      await expect(assertSafeUrl('http://example.com')).rejects.toThrow('Cannot resolve hostname');
    });

    it('should handle null DNS response', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(null as any);
      await expect(assertSafeUrl('http://example.com')).rejects.toThrow('Cannot resolve hostname');
    });

    it('should check all resolved IPs, reject if any is private', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34', '192.168.1.1'] as any);
      await expect(assertSafeUrl('http://example.com')).rejects.toThrow('Resolved IP is private');
    });

    it('should accept if all resolved IPs are public', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34', '8.8.8.8'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();
    });

    it('should handle IPv6 resolution when IPv4 fails', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('ENOTFOUND'));
      vi.mocked(dns.resolve6).mockResolvedValueOnce(['2001:4860:4860::8888'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();
    });

    it('should handle mixed IPv4/IPv6 addresses', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['93.184.216.34'] as any);
      await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined();
    });
  });
});
