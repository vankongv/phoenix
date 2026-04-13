function buildHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function parseGitHubError(res) {
  let payload = null;

  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  const apiMessage = payload?.message;
  const err = new Error(apiMessage || `GitHub API ${res.status}: ${res.statusText}`);
  err.status = res.status;
  err.documentationUrl = payload?.documentation_url;

  const rateRemaining = res.headers.get('x-ratelimit-remaining');
  const rateReset = res.headers.get('x-ratelimit-reset');
  const normalizedMessage = (apiMessage || '').toLowerCase();

  if (res.status === 401 || normalizedMessage.includes('bad credentials')) {
    err.userMessage =
      'The saved GitHub token is invalid or expired. Clear it and add a fresh token.';
    return err;
  }

  if (res.status === 403 && rateRemaining === '0') {
    const resetTime = rateReset ? new Date(Number(rateReset) * 1000) : null;
    const resetLabel = resetTime
      ? resetTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
    err.userMessage = resetLabel
      ? `GitHub API rate limit reached. Try again after ${resetLabel} or add a token.`
      : 'GitHub API rate limit reached. Add a token or try again later.';
    return err;
  }

  if (normalizedMessage.includes('resource not accessible by personal access token')) {
    err.userMessage =
      'Your token does not have access to this repository. Use a token with repository access or clear it for public repos.';
    return err;
  }

  if (normalizedMessage.includes('saml') || normalizedMessage.includes('single sign-on')) {
    err.userMessage =
      'This token needs organization SSO authorization before it can access the repository.';
    return err;
  }

  if (res.status === 404) {
    err.userMessage = 'Repo not found or not accessible.';
    return err;
  }

  err.userMessage = apiMessage || `GitHub API ${res.status}: ${res.statusText}`;
  return err;
}

async function fetchIssuesPage(repo, page, token, attempt = 0) {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`;
  let res;
  try {
    res = await fetch(url, { headers: buildHeaders(token) });
  } catch (networkErr) {
    // Transient network failure — retry up to 2 times with backoff
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return fetchIssuesPage(repo, page, token, attempt + 1);
    }
    throw networkErr;
  }

  if (res.ok) {
    return { data: await res.json(), token };
  }

  // Retry on 5xx server errors (up to 2 retries)
  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    return fetchIssuesPage(repo, page, token, attempt + 1);
  }

  const originalError = await parseGitHubError(res);

  // If token fails, try without it (public repos)
  if (
    (res.status === 401 ||
      (res.status === 403 && res.headers.get('x-ratelimit-remaining') !== '0')) &&
    token
  ) {
    const fallbackRes = await fetch(url, { headers: buildHeaders(null) });
    if (fallbackRes.ok) {
      return { data: await fallbackRes.json(), token: null };
    }
  }

  throw originalError;
}

export async function fetchAllIssues(repo) {
  let token = localStorage.getItem('gh_token');
  let issues = [];
  let page = 1;

  while (true) {
    const result = await fetchIssuesPage(repo, page, token);
    token = result.token;

    const data = result.data;
    issues = issues.concat(data.filter((issue) => !issue.pull_request));

    if (data.length < 100 || page >= 10) break;
    page++;
  }

  return issues;
}

export async function fetchUserRepos() {
  const token = localStorage.getItem('gh_token');
  if (!token) return [];
  const res = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member',
    { headers: buildHeaders(token) }
  );
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

export async function searchPublicRepos(query) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await parseGitHubError(res);
  const data = await res.json();
  return data.items;
}

/**
 * Create a new GitHub issue via POST.
 * Throws a parsed error if the request fails.
 */
export async function createIssue(repo, { title, body, labels }) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/issues`;
  const payload = { title };
  if (body) payload.body = body;
  if (labels) payload.labels = labels;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Fetch all members of a GitHub organization.
 * Falls back to repo collaborators if the org endpoint returns 404 (user-owned repos).
 */
export async function fetchOrgMembers(org, repoFallback) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/orgs/${org}/members?per_page=100`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (res.ok) return res.json();
  // 404 = personal account (not an org) — fall back to repo collaborators
  if (res.status === 404 && repoFallback) {
    const fallbackUrl = `https://api.github.com/repos/${repoFallback}/collaborators?per_page=100`;
    const fallbackRes = await fetch(fallbackUrl, { headers: buildHeaders(token) });
    if (fallbackRes.ok) return fallbackRes.json();
  }
  throw await parseGitHubError(res);
}

/**
 * Fetch all comments for a GitHub issue.
 * Throws a parsed error if the request fails.
 */
export async function fetchIssueComments(repo, issueNumber) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Create a comment on a GitHub issue via POST.
 * Throws a parsed error if the request fails.
 */
export async function createIssueComment(repo, issueNumber, body) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Fetch all collaborators for a repository.
 * Throws a parsed error if the request fails.
 */
export async function fetchRepoCollaborators(repo) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/collaborators?per_page=100`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Create a new label in a repository via POST.
 * Throws a parsed error if the request fails.
 */
export async function createRepoLabel(repo, { name, color }) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/labels`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Fetch all labels defined in a repository.
 * Throws a parsed error if the request fails.
 */
export async function fetchRepoLabels(repo) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/labels?per_page=100`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}

/**
 * Update a GitHub issue's title, body, assignees, and/or labels via PATCH.
 * Throws a parsed error if the request fails.
 */
export async function updateIssue(repo, issueNumber, { title, body, assignees, labels }) {
  const token = localStorage.getItem('gh_token');
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
  const payload = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (assignees !== undefined) payload.assignees = assignees;
  if (labels !== undefined) payload.labels = labels;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw await parseGitHubError(res);
  return res.json();
}
