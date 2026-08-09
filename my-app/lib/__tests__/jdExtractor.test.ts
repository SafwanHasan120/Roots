import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractJD, clearJDCache, type ExtractedJD } from '../jdExtractor';
import * as rateLimiter from '../rateLimiter';
import * as retryManager from '../retryManager';

vi.mock('../rateLimiter');
vi.mock('../retryManager');

describe('jdExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearJDCache();
  });

  afterEach(() => {
    clearJDCache();
  });

  describe('extractJD', () => {
    describe('JSON-LD extraction', () => {
      it('should extract from JSON-LD JobPosting schema with description', async () => {
        const html = `
          <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "description": "This role has amazing responsibilities and qualifications required for the position. We are looking for talented software engineers with experience in building scalable systems. The responsibilities include architecting microservices, implementing backend systems, and working with distributed databases. Your qualifications should include solid understanding of software engineering principles, experience with cloud platforms, and ability to work in a fast-paced environment. This is an excellent opportunity to work with cutting-edge technologies and talented engineers."
          }
          </script>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.method).toBe('jsonld');
        expect(result.confidence).toBe('high');
        expect(result.text).toContain('responsibilities');
      });

      it('should extract from JSON-LD with qualifications and responsibilities', async () => {
        const html = `
          <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "description": "Join our engineering team and build amazing products that impact millions of users worldwide. We are seeking talented engineers to work on challenging problems.",
            "qualifications": "You need 5 years of experience with Python and experience with distributed systems. Required qualifications include strong problem-solving skills, familiarity with cloud platforms like AWS or GCP, and experience with database design patterns.",
            "responsibilities": "Your responsibilities include managing the technical direction of projects, mentoring junior engineers, and delivering results on tight timelines. You will be responsible for designing scalable architectures and implementing core features."
          }
          </script>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.method).toBe('jsonld');
        expect(result.text).toContain('experience');
        expect(result.text).toContain('responsibilities');
      });

      it('should mark low confidence if JSON-LD fails quality gate', async () => {
        const html = `
          <script type="application/ld+json">
          {
            "@type": "JobPosting",
            "description": "Short"
          }
          </script>
          <div>This is a longer text that has qualifications and requirements for the job that is quite extensive</div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        // Falls back to HTML extraction since JSON-LD is too short
        expect(result.method).toBe('html');
        expect(result.text.length).toBeGreaterThan(0);
      });
    });

    describe('HTML extraction', () => {
      it('should extract text from HTML and pass quality gate', async () => {
        const html = `
          <html>
            <div class="job-description">
              <h1>Software Engineer</h1>
              <h2>Responsibilities</h2>
              <p>You will be responsible for building scalable systems and maintaining production infrastructure. Your responsibilities include designing APIs, implementing features, and conducting code reviews. We need someone with experience with distributed systems, microservices architecture, and cloud-native technologies. You will be working on challenging problems that impact millions of users. Experience with Python, Go, or Rust is preferred. Your experience with DevOps practices and CI/CD pipelines is essential. This is a role where you can make a real impact and grow your technical skills. Join our team of experienced engineers who are passionate about building reliable systems.</p>
            </div>
          </html>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.method).toBe('html');
        expect(result.confidence).toBe('high');
        expect(result.text).toContain('responsibilities');
      });

      it('should strip script and style tags from HTML', async () => {
        const html = `
          <html>
            <script>alert('xss')</script>
            <style>body { display: none; }</style>
            <div>This role has great qualifications and responsibilities for your career experience. We are looking for talented engineers with solid qualifications. The responsibilities include building microservices, working with cloud infrastructure, and implementing scalable solutions. Your experience with software development and understanding of system design principles are essential. This position offers excellent opportunities for professional growth and learning.</div>
          </html>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text).not.toContain('xss');
        expect(result.text).not.toContain('display: none');
      });

      it('should strip nav, header, footer, aside tags', async () => {
        const html = `
          <html>
            <nav>Navigation content</nav>
            <header>Header stuff</header>
            <main>
              <div>This job requires qualifications and experience with requirements for the role.</div>
            </main>
            <footer>Footer content</footer>
            <aside>Sidebar</aside>
          </html>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text).not.toContain('Navigation content');
        expect(result.text).not.toContain('Header stuff');
        expect(result.text).not.toContain('Footer content');
        expect(result.text).not.toContain('Sidebar');
      });

      it('should mark low confidence if HTML fails quality gate', async () => {
        const html = `
          <html>
            <div>Some random content without requirements or qualifications or experience</div>
          </html>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.confidence).toBe('low');
      });

      it('should find largest text block in HTML', async () => {
        const html = `
          <html>
            <div>Small</div>
            <div>This is a much longer block with lots of qualifications and requirements and experience details. It talks about your responsibilities and what experience with various technologies is needed for this position. This is definitely the main content.</div>
            <div>Another small piece</div>
          </html>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text).toContain('main content');
        expect(result.text).not.toContain('Small');
      });
    });

    describe('Quality gate', () => {
      it('should reject text shorter than 400 chars', async () => {
        const html = `
          <div>Short text with requirements but too small.</div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.confidence).toBe('low');
      });

      it('should reject text without required keywords', async () => {
        const html = `
          <div>Lorem ipsum dolor sit amet. This is a very long text but it does not contain the right keywords about job content or duties. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum.</div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.confidence).toBe('low');
      });

      it('should accept text with "you\'ll" keyword', async () => {
        const html = `
          <div>Lorem ipsum dolor sit amet consectetur adipiscing elit. You'll be responsible for amazing things in this role. It's a great opportunity for someone with experience in software development. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.confidence).toBe('high');
        expect(result.text).toContain("You'll");
      });

      it('should accept text with "you will" keyword', async () => {
        const html = `
          <div>Lorem ipsum dolor sit amet consectetur adipiscing elit. You will be working on challenging problems. Experience with cloud systems is required and your experience with developing software is essential. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.confidence).toBe('high');
      });
    });

    describe('Truncation', () => {
      it('should truncate to 8000 chars', async () => {
        const longText = 'a'.repeat(10000) + ' Requirements for this job include experience and qualifications.';
        const html = `<div>${longText}</div>`;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text.length).toBeLessThanOrEqual(8000);
      });

      it('should slice around requirement headings', async () => {
        const html = `
          <div>
            Some intro text here
            Requirements
            This section has all the qualifications and experience needed for the role
            ${'x'.repeat(8500)}
          </div>
        `;

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text.length).toBeLessThanOrEqual(8000);
        expect(result.text).toContain('Requirements');
      });
    });

    describe('Caching', () => {
      it('should cache results for 6 hours', async () => {
        const html = '<div>Text with requirements and qualifications and experience details for the position.</div>';

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result1 = await extractJD('https://example.com/job');

        // Clear mocks
        vi.clearAllMocks();

        // Second call should use cache
        const result2 = await extractJD('https://example.com/job');

        expect(result2.text).toBe(result1.text);
        // Fetch should not be called again
        expect(rateLimiter.rateLimitedFetch).not.toHaveBeenCalled();
      });
    });

    describe('Error handling', () => {
      it('should throw if fetch fails', async () => {
        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockRejectedValueOnce(
          new Error('Network error')
        );

        await expect(extractJD('https://example.com/job')).rejects.toThrow(
          'Failed to extract job description'
        );
      });

      it('should return low confidence if extraction yields empty text', async () => {
        const html = '<html></html>';

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(
          new Response(html, { status: 200 })
        );

        const result = await extractJD('https://example.com/job');

        expect(result.text).toBe('');
        expect(result.confidence).toBe('low');
      });
    });

    describe('finalUrl tracking', () => {
      it('should return the final URL after redirects', async () => {
        const html = '<div>Requirements and qualifications for experience in this role.</div>';
        const response = new Response(html, { status: 200 });
        Object.defineProperty(response, 'url', {
          value: 'https://example.com/final-url',
        });

        vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
          (url, fn) => fn()
        );
        vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(response);

        const result = await extractJD('https://example.com/job');

        expect(result.finalUrl).toBe('https://example.com/final-url');
      });
    });
  });
});
