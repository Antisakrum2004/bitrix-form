/**
 * GitHub API helpers for Vercel deployment
 * Uses GitHub REST API to trigger workflows and manage cron schedules
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Antisakrum2004/bitrix-form';
const GITHUB_API = 'https://api.github.com';

interface GitHubFile {
  content: string;
  sha: string;
}

async function githubFetch(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    cache: 'no-store', // Prevent Next.js from caching GitHub API responses
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'EOD-Inspector-Panel',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Read a file from the repository
 * Adds a cache-busting timestamp to ensure fresh SHA
 */
export async function getFile(path: string): Promise<GitHubFile> {
  const bust = `&_t=${Date.now()}`;
  const data = await githubFetch(`/repos/${GITHUB_REPO}/contents/${path}?ref=main${bust}`);
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

/**
 * Create or update a file in the repository
 * Includes retry logic for 409 SHA conflicts
 */
export async function putFile(path: string, content: string, sha: string, message: string, retryCount = 1): Promise<any> {
  try {
    return await githubFetch(`/repos/${GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        sha,
        branch: 'main',
      }),
    });
  } catch (err: any) {
    // If 409 conflict, re-fetch the file SHA and retry
    if (err.message?.includes('409') && retryCount > 0) {
      console.log(`SHA conflict for ${path}, retrying with fresh SHA...`);
      const freshFile = await getFile(path);
      return putFile(path, content, freshFile.sha, message, retryCount - 1);
    }
    throw err;
  }
}

/**
 * Trigger a workflow dispatch
 */
export async function triggerWorkflow(workflowId: string, inputs: Record<string, string> = {}): Promise<{ status: number }> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'EOD-Inspector-Panel',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });

  // GitHub returns 204 for successful dispatch
  return { status: res.status };
}

/**
 * Get recent workflow runs
 */
export async function getWorkflowRuns(workflowId: string, perPage = 5): Promise<any> {
  return githubFetch(`/repos/${GITHUB_REPO}/actions/workflows/${workflowId}/runs?per_page=${perPage}`);
}

/**
 * Parse cron from workflow YAML content
 */
export function parseCronFromYaml(yaml: string): string | null {
  const match = yaml.match(/cron:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * Convert MSK time string (HH:MM) to cron expression
 */
export function mskToCron(timeStr: string, days: string = '1-5'): string {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 3;
  if (utcH < 0) utcH += 24;
  return `${m} ${utcH} * * ${days}`;
}

/**
 * Convert cron expression to MSK time string
 */
export function cronToMsk(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return '00:00';
  const m = parts[0].padStart(2, '0');
  let utcH = parseInt(parts[1], 10);
  let mskH = utcH + 3;
  if (mskH >= 24) mskH -= 24;
  return `${String(mskH).padStart(2, '0')}:${m}`;
}

/**
 * Parse cron days from YAML
 */
export function parseCronDays(yaml: string): number[] {
  const match = yaml.match(/cron:\s*['"][^'"]*\*\s*\*\s*\*\s*([^'"]+)['"]/);
  if (!match) return [1, 2, 3, 4, 5];
  const daysStr = match[1].trim();
  if (daysStr === '1-5') return [1, 2, 3, 4, 5];
  if (daysStr === '*') return [0, 1, 2, 3, 4, 5, 6];
  return daysStr.split(',').map(Number).filter(n => !isNaN(n));
}

/**
 * Update cron in YAML content
 */
export function updateCronInYaml(yaml: string, newCron: string): string {
  return yaml.replace(/cron:\s*['"][^'"]+['"]/, `cron: '${newCron}'`);
}

/**
 * Days array to cron days string
 */
export function daysToCronStr(days: number[]): string {
  if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) return '1-5';
  if (days.length === 7) return '*';
  return days.sort().join(',');
}
