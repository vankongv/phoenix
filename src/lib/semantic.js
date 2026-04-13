import { SEMANTIC_BASE_URL } from './config.js';

// Allow runtime override via localStorage (useful for pointing at a remote instance).
const SEMANTIC_API = () => localStorage.getItem('semantic_api') || SEMANTIC_BASE_URL;

/**
 * Fetch semantically similar issues for a given GitHub issue.
 * @param {string} repo  e.g. "vercel/next.js"
 * @param {number} number GitHub issue number
 * @returns {Promise<Array<{issueId:string,number:number,title:string,similarity:number}>>}
 */
export async function fetchSimilar(repo, number) {
  const url = `${SEMANTIC_API()}/issues/similar?repo=${encodeURIComponent(repo)}&number=${number}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.similar ?? [];
  } catch {
    // Silently degrade — semantic API may not be running
    return [];
  }
}

/**
 * Batch-fetch duplicates for all issues in the Triage column.
 * Returns a Map<issueNumber, similar[]>.
 */
export async function loadTriageDuplicates(triageIssues, repo) {
  const results = new Map();
  if (!triageIssues.length) return results;

  // Fire all requests in parallel, cap at 10 concurrent
  const chunks = [];
  for (let i = 0; i < triageIssues.length; i += 10) {
    chunks.push(triageIssues.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (issue) => {
        const similar = await fetchSimilar(repo, issue.number);
        if (similar.length > 0) results.set(issue.number, similar);
      })
    );
  }

  return results;
}
