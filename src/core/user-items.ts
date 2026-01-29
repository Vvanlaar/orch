import { Octokit } from 'octokit';
import { config } from './config.js';

const octokit = new Octokit({ auth: config.github.token });

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  repo: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  role: 'author' | 'reviewer' | 'mentioned';
}

export interface AdoWorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
  url: string;
  assignedTo: string;
  resolvedBy?: string;
  reviewedBy?: string;
  iterationPath?: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
  githubPrUrl?: string;
  testNotes?: string;
  body?: string;
}

export interface TeamMember {
  displayName: string;
  email: string;
  id: string;
}

export interface AdoUser {
  displayName: string;
  email: string;
  id: string;
}

function extractRepoFromUrl(repositoryUrl: string): string {
  const parts = repositoryUrl.split('/');
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function mapPrToGitHubPR(pr: any, role: 'author' | 'reviewer'): GitHubPR {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft || false,
    repo: extractRepoFromUrl(pr.repository_url),
    url: pr.html_url,
    author: pr.user?.login || '',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    role,
  };
}

async function searchGitHubPRs(query: string): Promise<any[]> {
  const res = await fetch(
    `https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=20`,
    { headers: { Authorization: `token ${config.github.token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  const data = await res.json();
  return data.items || [];
}

export async function getMyGitHubPRs(): Promise<GitHubPR[]> {
  if (!config.github.token) {
    console.log('[UserItems] No GITHUB_TOKEN configured');
    return [];
  }

  try {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`[UserItems] Fetching PRs for GitHub user: ${user.login}`);

    const [authored, reviewing] = await Promise.all([
      searchGitHubPRs(`is:pr+is:open+author:${user.login}`),
      searchGitHubPRs(`is:pr+is:open+review-requested:${user.login}`),
    ]);

    const prs: GitHubPR[] = authored.map(pr => mapPrToGitHubPR(pr, 'author'));
    const seenUrls = new Set(prs.map(p => p.url));

    for (const pr of reviewing) {
      if (!seenUrls.has(pr.html_url)) {
        prs.push(mapPrToGitHubPR(pr, 'reviewer'));
      }
    }

    prs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    console.log(`[UserItems] Found ${prs.length} GitHub PRs`);
    return prs;
  } catch (err) {
    console.error('[UserItems] Error fetching GitHub PRs:', err);
    return [];
  }
}

function getAdoAuth(): string {
  return Buffer.from(`:${config.ado.pat}`).toString('base64');
}

function checkAdoConfig(): boolean {
  if (!config.ado.pat) {
    console.log('[UserItems] No ADO_PAT configured');
    return false;
  }
  if (!config.ado.organization) {
    console.log('[UserItems] No ADO_ORG configured');
    return false;
  }
  return true;
}

function extractGitHubPrUrl(fields: Record<string, any>): string {
  const allText = JSON.stringify(fields);
  const match = allText.match(/https:\/\/github\.com\/[^"'\s]+\/pull\/\d+/);
  return match ? match[0] : '';
}

function mapWorkItemToAdoItem(wi: any): AdoWorkItem {
  const fields = wi.fields || {};
  return {
    id: wi.id,
    title: fields['System.Title'] || 'Untitled',
    state: fields['System.State'] || 'Unknown',
    type: fields['System.WorkItemType'] || 'Item',
    url: `https://dev.azure.com/${config.ado.organization}/${fields['System.TeamProject'] || '_'}/_workitems/edit/${wi.id}`,
    assignedTo: fields['System.AssignedTo']?.displayName || '',
    resolvedBy: fields['Microsoft.VSTS.Common.ResolvedBy']?.displayName || '',
    project: fields['System.TeamProject'] || '',
    createdAt: fields['System.CreatedDate'] || '',
    updatedAt: fields['System.ChangedDate'] || '',
    resolution: fields['Microsoft.VSTS.Common.Resolution'] || fields['System.Description'] || '',
    githubPrUrl: extractGitHubPrUrl(fields),
    testNotes: fields['Microsoft.VSTS.TCM.TestNotes'] || fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || fields['Custom.TestNotes'] || '',
    body: fields['System.Description'] || '',
  };
}

async function fetchAdoWorkItemsByQuery(wiqlQuery: string, logPrefix: string): Promise<AdoWorkItem[]> {
  if (!checkAdoConfig()) return [];

  console.log(`[UserItems] ${logPrefix} from ADO org: ${config.ado.organization}`);
  const auth = getAdoAuth();

  try {
    const wiqlUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/wiql?api-version=7.1`;
    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({ query: wiqlQuery }),
    });

    if (!wiqlRes.ok) {
      console.error(`[UserItems] ADO WIQL failed (${wiqlRes.status}):`, await wiqlRes.text());
      return [];
    }

    const wiqlData = await wiqlRes.json();
    const workItemIds = (wiqlData.workItems || []).slice(0, 30).map((w: { id: number }) => w.id);
    console.log(`[UserItems] ADO WIQL returned ${workItemIds.length} work item IDs`);

    if (workItemIds.length === 0) return [];

    const detailsUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workitems?ids=${workItemIds.join(',')}&api-version=7.1`;
    const detailsRes = await fetch(detailsUrl, { headers: { Authorization: `Basic ${auth}` } });

    if (!detailsRes.ok) {
      console.error(`[UserItems] ADO details fetch failed (${detailsRes.status}):`, await detailsRes.text());
      return [];
    }

    const detailsData = await detailsRes.json();
    const items = (detailsData.value || []).map(mapWorkItemToAdoItem);
    console.log(`[UserItems] Found ${items.length} ADO work items`);
    return items;
  } catch (err) {
    console.error(`[UserItems] Error fetching ADO work items:`, err);
    return [];
  }
}

export async function getMyAdoWorkItems(): Promise<AdoWorkItem[]> {
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Completed' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;
  return fetchAdoWorkItemsByQuery(query, 'Fetching work items');
}

export async function getMyResolvedWorkItems(): Promise<AdoWorkItem[]> {
  const query = `SELECT [System.Id] FROM WorkItems WHERE [Microsoft.VSTS.Common.ResolvedBy] = @Me AND [System.AssignedTo] <> @Me AND ([System.State] = 'Resolved' OR [System.State] = 'Active' OR [System.State] = 'In Progress') ORDER BY [System.ChangedDate] DESC`;
  return fetchAdoWorkItemsByQuery(query, 'Fetching resolved-by-me work items');
}

export async function getCurrentSprint(): Promise<{ path: string; name: string } | null> {
  if (!config.ado.pat || !config.ado.organization || !config.ado.project || !config.ado.team) {
    console.log('[UserItems] ADO config incomplete for sprint lookup (need ADO_PROJECT and ADO_TEAM)');
    return null;
  }

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');
  const url = `https://dev.azure.com/${config.ado.organization}/${config.ado.project}/${config.ado.team}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      console.error(`[UserItems] Failed to get current sprint (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const iteration = data.value?.[0];
    if (!iteration) {
      console.log('[UserItems] No current iteration found');
      return null;
    }

    console.log(`[UserItems] Current sprint: ${iteration.path}`);
    return { path: iteration.path, name: iteration.name };
  } catch (err) {
    console.error('[UserItems] Error fetching current sprint:', err);
    return null;
  }
}

export async function getReviewedItemsInSprint(): Promise<{ sprintName: string; items: AdoWorkItem[] }> {
  const sprint = await getCurrentSprint();
  if (!sprint) {
    return { sprintName: '', items: [] };
  }

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');
  const items: AdoWorkItem[] = [];

  try {
    const wiqlUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/wiql?api-version=7.1`;
    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] UNDER '${sprint.path}' AND [System.State] = 'Reviewed' ORDER BY [System.ChangedDate] DESC`,
      }),
    });

    if (!wiqlRes.ok) {
      console.error(`[UserItems] ADO WIQL failed (${wiqlRes.status}):`, await wiqlRes.text());
      return { sprintName: sprint.name, items: [] };
    }

    const wiqlData = await wiqlRes.json();
    const workItemIds = (wiqlData.workItems || []).slice(0, 100).map((w: { id: number }) => w.id);
    console.log(`[UserItems] Found ${workItemIds.length} reviewed items in sprint ${sprint.name}`);

    if (workItemIds.length === 0) return { sprintName: sprint.name, items: [] };

    const idsParam = workItemIds.join(',');
    const detailsUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workitems?ids=${idsParam}&api-version=7.1`;
    const detailsRes = await fetch(detailsUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!detailsRes.ok) {
      console.error(`[UserItems] ADO details fetch failed (${detailsRes.status}):`, await detailsRes.text());
      return { sprintName: sprint.name, items: [] };
    }

    const detailsData = await detailsRes.json();
    const reviewedByField = config.ado.reviewedByField || 'Custom.ReviewedBy';

    for (const wi of detailsData.value || []) {
      const fields = wi.fields || {};

      items.push({
        id: wi.id,
        title: fields['System.Title'] || 'Untitled',
        state: fields['System.State'] || 'Unknown',
        type: fields['System.WorkItemType'] || 'Item',
        url: `https://dev.azure.com/${config.ado.organization}/${fields['System.TeamProject'] || '_'}/_workitems/edit/${wi.id}`,
        assignedTo: fields['System.AssignedTo']?.displayName || '',
        resolvedBy: fields['Microsoft.VSTS.Common.ResolvedBy']?.displayName || '',
        reviewedBy: fields[reviewedByField]?.displayName || fields[reviewedByField] || '',
        iterationPath: fields['System.IterationPath'] || '',
        project: fields['System.TeamProject'] || '',
        createdAt: fields['System.CreatedDate'] || '',
        updatedAt: fields['System.ChangedDate'] || '',
      });
    }
  } catch (err) {
    console.error('[UserItems] Error fetching reviewed items in sprint:', err);
  }

  return { sprintName: sprint.name, items };
}

export async function getCurrentAdoUser(): Promise<AdoUser | null> {
  if (!checkAdoConfig()) return null;

  const auth = getAdoAuth();
  const url = `https://dev.azure.com/${config.ado.organization}/_apis/connectionData?api-version=7.1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      console.error(`[UserItems] Failed to get current user (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const user = data.authenticatedUser;
    if (!user) {
      console.log('[UserItems] No authenticated user in response');
      return null;
    }

    console.log(`[UserItems] Current ADO user: ${user.providerDisplayName}`);
    return {
      displayName: user.providerDisplayName || user.customDisplayName || '',
      email: user.properties?.Account?.$value || '',
      id: user.id || '',
    };
  } catch (err) {
    console.error('[UserItems] Error fetching current ADO user:', err);
    return null;
  }
}

export async function getTeamMembers(): Promise<TeamMember[]> {
  if (!config.ado.pat || !config.ado.organization || !config.ado.project || !config.ado.team) {
    console.log('[UserItems] ADO config incomplete for team members (need ADO_PROJECT and ADO_TEAM)');
    return [];
  }

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');
  const url = `https://dev.azure.com/${config.ado.organization}/_apis/projects/${config.ado.project}/teams/${config.ado.team}/members?api-version=7.1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      console.error(`[UserItems] Failed to get team members (${res.status}):`, await res.text());
      return [];
    }

    const data = await res.json();
    const members: TeamMember[] = [];

    for (const m of data.value || []) {
      const identity = m.identity || m;
      members.push({
        displayName: identity.displayName || '',
        email: identity.uniqueName || identity.mailAddress || '',
        id: identity.id || '',
      });
    }

    console.log(`[UserItems] Found ${members.length} team members`);
    return members;
  } catch (err) {
    console.error('[UserItems] Error fetching team members:', err);
    return [];
  }
}
