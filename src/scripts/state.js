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
  onOpenDrawer: null,
  onImplement: null,
};
