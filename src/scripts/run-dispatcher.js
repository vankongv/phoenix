/**
 * run-dispatcher.js
 *
 * Business logic for dispatching agent runs: maps an issue + repo state to the
 * right agent(s) or team, then calls implement() / refine().
 *
 * Extracted from drawer.js so both the legacy drawer and the new Preact island
 * can import it without pulling in DOM code.
 */
import {
  implement,
  refine,
  cancelRun,
  pushRun,
  onRunUpdate,
  runStore,
  suggestionStore,
  logDelegation,
} from '../lib/implementer.js';
import { getAgents, getTeams, getIssueTeam, getGlobalAiKey } from '../lib/agents.js';
import { state } from './state.js';

export { cancelRun, pushRun };

// ── Agent config builder ──────────────────────────────────────────────────────

function _agentConfig(agent, team = null) {
  if (!agent) return {};
  const _prefixModel = (provider, model) => {
    if (!model) return undefined;
    return (provider === 'openai' || provider === 'copilot') && !model.startsWith('openai/')
      ? `openai/${model}`
      : model;
  };
  return {
    endpoint: agent.endpoint,
    mcpServers: agent.mcpServers ?? [],
    autonomy: agent.autonomy || undefined,
    llmModel: _prefixModel(agent.provider, agent.model),
    llmApiKey: agent.apiKey || getGlobalAiKey() || undefined,
    llmBaseUrl: agent.llmBaseUrl || undefined,
    fallbackLlmModel: _prefixModel(agent.fallbackProvider, agent.fallbackModel),
    systemPrompt: agent.systemPrompt || undefined,
    purpose: agent.purpose || undefined,
    reasoningPattern: agent.reasoningPattern || undefined,
    guardrailsAlways: agent.guardrailsAlways || undefined,
    guardrailsNever: agent.guardrailsNever || undefined,
    sampling: agent.sampling || undefined,
    agentName: agent.name || agent.id,
    agentModel: agent.model || agent.provider,
    agentActionType: agent.actionType || 'implement',
    teamName: team?.name || null,
    teamMode: team?.mode || null,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function triggerImplement(issue, overrideAgentId = null) {
  let issueColId = null;
  for (const [colId, col] of Object.entries(state.columns)) {
    if (col.issues?.some((i) => i.number === issue.number)) {
      issueColId = colId;
      break;
    }
  }

  const teams = getTeams();
  const agents = getAgents();

  if (overrideAgentId) {
    const agent = agents.find((a) => a.id === overrideAgentId);
    if (agent) {
      implement(issue, state.repoFullName, _agentConfig(agent, null));
      return;
    }
  }

  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;
  const assignedTeam = assignedTeamId ? teams.find((t) => t.id === assignedTeamId) : null;

  const prodTeam =
    assignedTeam ??
    teams.find(
      (t) =>
        t.status === 'production' &&
        (t.agents ?? []).some((id) =>
          agents.find((a) => a.id === id && (a.lanes ?? []).includes(issueColId))
        )
    );

  if (prodTeam && prodTeam.mode === 'sequential') {
    const teamAgents = (prodTeam.agents ?? [])
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean);

    let currentIssue = issue;
    for (let i = 0; i < teamAgents.length; i++) {
      const agent = teamAgents[i];
      const nextAgent = teamAgents[i + 1];

      if (agent.actionType === 'refine') {
        refine(currentIssue, _agentConfig(agent, prodTeam));
        await new Promise((resolve) => {
          const unsub = onRunUpdate((n) => {
            if (n !== issue.number) return;
            const run = runStore.get(n);
            if (run?.status === 'done' || run?.status === 'failed') {
              unsub();
              resolve();
            }
          });
        });
        const suggestion = suggestionStore.get(issue.number);
        if (suggestion) {
          currentIssue = {
            ...currentIssue,
            title: suggestion.title || currentIssue.title,
            body: [
              suggestion.description || currentIssue.body,
              ...(suggestion.acceptance_criteria?.length
                ? [
                    '\n### Acceptance Criteria',
                    ...suggestion.acceptance_criteria.map((c) => `- [ ] ${c}`),
                  ]
                : []),
            ].join('\n'),
          };
        }
        if (nextAgent) logDelegation(issue.number, agent.name, nextAgent.name);
      } else {
        implement(currentIssue, state.repoFullName, _agentConfig(agent, prodTeam));
        return;
      }
    }
    return;
  }

  if (prodTeam && prodTeam.mode === 'parallel') {
    const teamAgents = (prodTeam.agents ?? [])
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean);
    teamAgents.forEach((agent) => {
      if (agent.actionType === 'refine') {
        refine(issue, _agentConfig(agent, prodTeam));
      } else {
        implement(issue, state.repoFullName, _agentConfig(agent, prodTeam));
      }
    });
    return;
  }

  const agent =
    agents.find((a) => a.actionType === 'implement' && (a.lanes ?? []).includes(issueColId)) ??
    agents.find((a) => a.actionType === 'implement') ??
    agents.find((a) => a.id === 'implementer');

  implement(issue, state.repoFullName, _agentConfig(agent, null));
}

export function triggerRefine(issue) {
  const agents = getAgents();
  const agent =
    agents.find((a) => a.actionType === 'refine') ??
    agents.find((a) => a.id === 'refiner');
  refine(issue, _agentConfig(agent, null));
}
