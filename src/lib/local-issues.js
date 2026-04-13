/**
 * Local board issues — issues created in the planning panel that live on
 * the board before being pushed to GitHub.
 *
 * Stored in localStorage under 'pnx_local_board_issues' as { [repo]: issue[] }.
 * Local issues use negative issue numbers to avoid collisions with GitHub numbers.
 */

const STORAGE_KEY = 'pnx_local_board_issues';

function _load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function _save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Return all local issues for a repo, ordered most-recent first. */
export function getLocalIssues(repo) {
  const data = _load();
  return data[repo] ?? [];
}

/**
 * Add a new local issue for a repo.
 * Returns the created issue object (with negative number and _local flag).
 */
export function addLocalIssue(repo, { title, body }) {
  const data = _load();
  if (!data[repo]) data[repo] = [];
  const existing = data[repo].map((i) => i.number);
  const localNum = existing.length > 0 ? Math.min(...existing) - 1 : -1;
  const issue = {
    number: localNum,
    title,
    body: body || '',
    labels: [],
    assignees: [],
    state: 'open',
    comments: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: null,
    _local: true,
    _localId: crypto.randomUUID(),
  };
  data[repo].unshift(issue);
  _save(data);
  return issue;
}

/** Remove a local issue by its _localId. */
export function removeLocalIssue(repo, localId) {
  const data = _load();
  if (!data[repo]) return;
  data[repo] = data[repo].filter((i) => i._localId !== localId);
  _save(data);
}

/**
 * Replace a local issue with its real GitHub counterpart.
 * Removes from localStorage; caller is responsible for updating state.allIssues.
 */
export function promoteLocalIssue(repo, localId) {
  removeLocalIssue(repo, localId);
}
