import { LABEL_MAP } from './constants.js';

export function assignColumn(issue) {
  const names = (issue.labels || []).map((l) => l.name.toLowerCase());
  for (const { keywords, col } of LABEL_MAP) {
    if (names.some((n) => keywords.some((k) => n.includes(k)))) return col;
  }
  return issue.assignees?.length > 0 ? 'todo' : 'triage';
}
