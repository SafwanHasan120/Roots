import { rateLimitedFetch } from './rateLimiter';
import { fetchWithRetry } from './retryManager';

export interface JDAnalysis {
  required_skills: string[];
  preferred_skills: string[];
  domain: string;
  seniority_signals: string[];
  keywords: string[];
}

interface CachedAnalysis {
  data: JDAnalysis;
  cachedAt: number;
}

// In-memory cache for JD analysis (6h TTL, same as JD extraction)
const analysisCache = new Map<string, CachedAnalysis>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function analyzeJD(jdText: string, appUrl: string): Promise<JDAnalysis> {
  // Check cache first
  const cached = analysisCache.get(appUrl);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const systemPrompt = `You are a job description analyzer. Extract structured requirements from a job description.

Return ONLY valid JSON (no markdown, no extra text).

Analyze the JD and extract:
- required_skills: list of required technical/professional skills (strings)
- preferred_skills: list of nice-to-have skills (strings)
- domain: the primary domain (e.g., "backend", "full-stack", "data", "ml", "frontend", "devops")
- seniority_signals: signals about seniority level (e.g., "5+ years experience", "lead role", "staff level", "entry level")
- keywords: all important keywords/phrases (tech, methodologies, roles, etc.)

Keep lists concise. Avoid redundancy.`;

  try {
    const response = await rateLimitedFetch(appUrl, () =>
      fetchWithRetry(`https://api.anthropic.com/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          // Sonnet rather than a reasoning model: this is a short structured
          // extraction, and claude-opus-5 rejects `temperature`, which the
          // JSON-only output depends on for determinism.
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          temperature: 0,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: `Analyze this job description:\n\n${jdText}`,
            },
          ],
        }),
        timeoutMs: 10000,
        maxRetries: 2,
      })
    );

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const content = data.content?.find((block) => block.type === 'text');
    if (!content || !content.text) {
      throw new Error('Invalid Claude API response');
    }

    // Parse the JSON response. The prompt asks for bare JSON, but the model
    // still fences it often enough that parsing raw text silently degrades
    // tailoring to the no-JD path.
    let jsonText = content.text.trim();
    const fenced = jsonText.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
    if (fenced) jsonText = fenced[1].trim();
    const analysis: JDAnalysis = JSON.parse(jsonText);

    // Validate structure
    if (
      !Array.isArray(analysis.required_skills) ||
      !Array.isArray(analysis.preferred_skills) ||
      typeof analysis.domain !== 'string' ||
      !Array.isArray(analysis.seniority_signals) ||
      !Array.isArray(analysis.keywords)
    ) {
      throw new Error('Invalid JD analysis structure');
    }

    // Cache the result
    analysisCache.set(appUrl, {
      data: analysis,
      cachedAt: Date.now(),
    });

    return analysis;
  } catch (error) {
    console.error('JD analysis failed:', error);
    throw new Error(`Failed to analyze job description: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function clearAnalysisCache(): void {
  analysisCache.clear();
}

export function getAnalysisCacheStats() {
  return {
    cachedUrls: analysisCache.size,
    entries: Array.from(analysisCache.entries()).map(([url, cached]) => ({
      url,
      age: Date.now() - cached.cachedAt,
      skillCount: cached.data.required_skills.length + cached.data.preferred_skills.length,
    })),
  };
}
