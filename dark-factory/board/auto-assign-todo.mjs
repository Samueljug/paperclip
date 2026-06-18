import { argv, env } from 'process';

const apiUrl = env.PAPERCLIP_API_URL || 'http://127.0.0.1:3101';
const apiKey = env.PAPERCLIP_API_KEY;
const companyId = env.PAPERCLIP_COMPANY_ID || '1e8bc12a-f8fd-431c-9fbd-e47be79446a3';
const projectId = env.PAPERCLIP_PROJECT_ID || 'c4525f28-55d1-4378-864c-aec26d51fc37';
const runId = env.PAPERCLIP_RUN_ID;

if (!apiKey) {
  console.error('Error: PAPERCLIP_API_KEY is required.');
  process.exit(1);
}

const LEADS = {
  planning: 'c5d27df5-9708-4864-bbce-dd767be2790f',      // planning-lead
  implementation: 'bc23520c-4774-4257-a667-8687bc539b72',  // implementation-lead
  docs: '1476459f-6217-45bb-9399-89bc585ad904',            // docs-release-lead
  security: '19dd3bb9-15d8-4ecb-81de-cb8f3ffbbb21',        // security-lead
  verification: '055e7f14-e5c2-4086-a256-1d6e37b3c35c',    // verification-lead
  browser: '8b2249ab-3d67-4572-8e6e-0401faee096e',         // browser-qa-lead
  research: 'e4db3ff9-cc2c-4ae5-8533-f2a55a32c8ee',        // research-lead
};

function determineLead(title, description) {
  const text = `${title} ${description}`.toLowerCase();

  // 1. Security / privacy / authz
  if (
    text.includes('security') ||
    text.includes('privacy') ||
    text.includes('authz') ||
    text.includes('auth') ||
    text.includes('encryption') ||
    text.includes('vulnerability') ||
    text.includes('idor') ||
    text.includes('takeover') ||
    text.includes('leak') ||
    text.includes('credential') ||
    text.includes('jwt') ||
    text.includes('token') ||
    text.includes('[sec]')
  ) {
    return { id: LEADS.security, name: 'security-lead' };
  }

  // 2. Browser / UI / visual
  if (
    text.includes('browser') ||
    text.includes('ui') ||
    text.includes('visual') ||
    text.includes('css') ||
    text.includes('style') ||
    text.includes('render') ||
    text.includes('element') ||
    text.includes('component') ||
    text.includes('blank page') ||
    text.includes('screen') ||
    text.includes('button') ||
    text.includes('form') ||
    text.includes('layout') ||
    text.includes('toast') ||
    text.includes('mobile') ||
    text.includes('[fe]')
  ) {
    return { id: LEADS.browser, name: 'browser-qa-lead' };
  }

  // 3. Tests / verification / correctness
  if (
    text.includes('test') ||
    text.includes('verification') ||
    text.includes('correctness') ||
    text.includes('assert') ||
    text.includes('playwright') ||
    text.includes('vitest') ||
    text.includes('jest') ||
    text.includes('verify')
  ) {
    return { id: LEADS.verification, name: 'verification-lead' };
  }

  // 4. Docs / wiki / readme
  if (
    text.includes('docs') ||
    text.includes('wiki') ||
    text.includes('readme') ||
    text.includes('document') ||
    text.includes('markdown') ||
    text.includes('changelog')
  ) {
    return { id: LEADS.docs, name: 'docs-release-lead' };
  }

  // 5. Research / investigation
  if (
    text.includes('research') ||
    text.includes('investigation') ||
    text.includes('dossier') ||
    text.includes('architecture') ||
    text.includes('design') ||
    text.includes('rfc')
  ) {
    return { id: LEADS.research, name: 'research-lead' };
  }

  // 6. Planning / spec / decomposition
  if (
    text.includes('planning') ||
    text.includes('spec') ||
    text.includes('decomposition') ||
    text.includes('plan') ||
    text.includes('breakdown')
  ) {
    return { id: LEADS.planning, name: 'planning-lead' };
  }

  // 7. Backend / frontend / code / bug / default (if unclear/multi-area, planning-lead)
  // Let's check for backend/code/bug/endpoint first, if yes implementation-lead
  if (
    text.includes('backend') ||
    text.includes('code') ||
    text.includes('bug') ||
    text.includes('error') ||
    text.includes('exception') ||
    text.includes('fix') ||
    text.includes('refactor') ||
    text.includes('migration') ||
    text.includes('db') ||
    text.includes('database') ||
    text.includes('query') ||
    text.includes('endpoint') ||
    text.includes('api') ||
    text.includes('server') ||
    text.includes('route') ||
    text.includes('[be]') ||
    text.includes('[api]')
  ) {
    return { id: LEADS.implementation, name: 'implementation-lead' };
  }

  // Default / unclear / multi-area -> planning-lead
  return { id: LEADS.planning, name: 'planning-lead (default/unclear)' };
}

async function runSweep() {
  const url = `${apiUrl}/api/companies/${companyId}/issues?projectId=${projectId}`;
  console.log(`Fetching issues from ${url}...`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch issues: ${res.status} ${res.statusText}`);
  }

  const issues = await res.json();
  console.log(`Found ${issues.length} total issues in project.`);

  const todoUnassigned = issues.filter(
    (issue) => issue.status === 'todo' && !issue.assigneeAgentId
  );

  console.log(`Found ${todoUnassigned.length} unassigned To-Do issues.`);

  const assignedList = [];

  for (const issue of todoUnassigned) {
    // Ignore this sweep card itself (though the query has status === 'todo', and this card is 'in_progress', but safety check)
    if (issue.identifier === 'OPE-547' || issue.title.includes('Auto-assign To-Do cards')) {
      continue;
    }

    const lead = determineLead(issue.title, issue.description || '');
    console.log(`Assigning ${issue.identifier} ("${issue.title}") to ${lead.name} (${lead.id})...`);

    const patchUrl = `${apiUrl}/api/issues/${issue.id}`;
    const patchHeaders = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (runId) {
      patchHeaders['X-Paperclip-Run-Id'] = runId;
    }

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: patchHeaders,
      body: JSON.stringify({
        assigneeAgentId: lead.id,
      }),
    });

    if (!patchRes.ok) {
      console.error(`Failed to assign issue ${issue.identifier}: ${patchRes.status} ${patchRes.statusText}`);
    } else {
      console.log(`Successfully assigned ${issue.identifier}.`);
      assignedList.push({
        identifier: issue.identifier,
        title: issue.title,
        lead: lead.name,
      });
    }
  }

  return assignedList;
}

runSweep().then((assignedList) => {
  console.log('Sweep completed.');
  if (assignedList.length === 0) {
    console.log('No issues were assigned.');
  } else {
    console.log('Assigned issues:');
    console.log(JSON.stringify(assignedList, null, 2));
  }
}).catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
