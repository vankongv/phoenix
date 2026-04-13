// Shared application state — imported by all script modules.
// Callbacks (onOpenDrawer, onImplement) are set by main.js after module init.
export const state = {
  allIssues: [],
  columns: {},
  dragNum: null,
  dragFrom: null,
  repoFullName: '',
  duplicates: new Map(), // issueNumber → DuplicateCandidate[]
  repos: [], // fetched repo list from /user/repos
  projectMeta: null, // { projectId, statusFieldId, statusOptions: Map<name, optionId> } — set when a GitHub Project with a Status field is found
  forkInfo: null, // null = not a fork; { parentRepo: 'owner/repo', useUpstream: true } when repo is a fork
  issueSourceRepo: '', // the repo actually used for fetching issues (may differ from repoFullName for forks)
  onOpenDrawer: null,
  onImplement: null,
};
