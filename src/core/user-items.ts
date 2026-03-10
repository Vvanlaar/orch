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
  commentCount?: number;
  adoTicketId?: number;
  adoTicketUrl?: string;
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
  repositories?: string[];
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
  const adoMatch = pr.title?.match(/(?:AB|ADO)?#(\d{4,6})/i);
  const adoTicketId = adoMatch ? parseInt(adoMatch[1]) : undefined;
  const adoTicketUrl = adoTicketId && config.ado.organization
    ? `https://dev.azure.com/${config.ado.organization}/_workitems/edit/${adoTicketId}`
    : undefined;
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
    commentCount: pr.comments || 0,
    adoTicketId,
    adoTicketUrl,
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

// Cache for getMyGitHubPRs (5min TTL)
let myPRsCache: { items: GitHubPR[]; expiry: number } | null = null;
const MY_PRS_TTL = 5 * 60 * 1000;

export async function getMyGitHubPRs(refresh = false): Promise<GitHubPR[]> {
  if (!config.github.token) {
    console.log('[UserItems] No GITHUB_TOKEN configured');
    return [];
  }

  const now = Date.now();
  if (!refresh && myPRsCache && now < myPRsCache.expiry) {
    return myPRsCache.items;
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
    myPRsCache = { items: prs, expiry: Date.now() + MY_PRS_TTL };
    console.log(`[UserItems] Found ${prs.length} GitHub PRs`);
    return prs;
  } catch (err) {
    console.error('[UserItems] Error fetching GitHub PRs:', err);
    return [];
  }
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function getAdoAuth(): string {
  return Buffer.from(`:${config.ado.pat}`).toString('base64');
}

function checkAdoConfig(...extraFields: (keyof typeof config.ado)[]): boolean {
  if (!config.ado.pat) {
    console.log('[UserItems] No ADO_PAT configured');
    return false;
  }
  if (!config.ado.organization) {
    console.log('[UserItems] No ADO_ORG configured');
    return false;
  }
  for (const field of extraFields) {
    if (!config.ado[field]) {
      console.log(`[UserItems] No ADO config for ${field}`);
      return false;
    }
  }
  return true;
}

function extractGitHubPrUrl(fields: Record<string, any>, relations?: any[]): string {
  // Check relations first (ADO Development links)
  if (relations) {
    for (const rel of relations) {
      const url = rel.url || '';
      const name = rel.attributes?.name || '';

      // GitHub PR artifact links have vstfs:///GitHub/PullRequest/ format, but the url field has the API URL
      // The actual PR URL is in the attributes.name or we can construct from the relation
      if (url.includes('github.com') && url.includes('/pull/')) {
        const match = url.match(/https:\/\/github\.com\/[^"'\s<>]+\/pull\/\d+/);
        if (match) return match[0];
      }
      // Check attributes for GitHub links
      if (name.includes('github.com') && name.includes('/pull/')) {
        const match = name.match(/https:\/\/github\.com\/[^"'\s<>]+\/pull\/\d+/);
        if (match) return match[0];
      }
    }
  }

  // Check dedicated GitHub PR fields
  const prFields = [
    'Custom.GitHubPullRequest',
    'Custom.GitHubPRUrl',
    'Custom.GithubPullRequest',
    'Custom.PRLink',
    'Custom.PullRequestUrl',
  ];
  for (const field of prFields) {
    const val = fields[field];
    if (val && typeof val === 'string' && val.includes('github.com')) {
      const urlMatch = val.match(/https:\/\/github\.com\/[^"'\s<>]+\/pull\/\d+/);
      if (urlMatch) return urlMatch[0];
    }
  }

  // Fallback: search all text for GitHub PR URL
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
    githubPrUrl: extractGitHubPrUrl(fields, wi.relations),
    testNotes: fields['Microsoft.VSTS.TCM.TestNotes'] || fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || fields['Custom.TestNotes'] || '',
    body: fields['System.Description'] || '',
    repositories: fields['Custom.Repository']
      ? fields['Custom.Repository'].split(';').map((s: string) => s.trim()).filter(Boolean)
      : [],
  };
}

async function fetchAdoWorkItemsByQuery(wiqlQuery: string, logPrefix: string, limit = 30): Promise<AdoWorkItem[]> {
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
    const workItemIds = (wiqlData.workItems || []).slice(0, limit).map((w: { id: number }) => w.id);
    console.log(`[UserItems] ADO WIQL returned ${workItemIds.length} work item IDs`);

    if (workItemIds.length === 0) return [];

    const detailsUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workitems?ids=${workItemIds.join(',')}&$expand=relations&api-version=7.1`;
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

// Cache for PR comment lookups (5min TTL)
let prCommentsCache: { items: (AdoWorkItem & { commentCount: number })[]; expiry: number } | null = null;
let cachedGitHubUsername: string | null = null;

async function getGitHubUsername(): Promise<string> {
  if (cachedGitHubUsername) return cachedGitHubUsername;
  const { data: user } = await octokit.rest.users.getAuthenticated();
  cachedGitHubUsername = user.login;
  return cachedGitHubUsername;
}

const PR_COMMENTS_TTL = 5 * 60 * 1000;

export async function getResolvedWithPRComments(refresh = false): Promise<(AdoWorkItem & { commentCount: number })[]> {
  if (!config.github.token) return [];

  const now = Date.now();
  if (!refresh && prCommentsCache && now < prCommentsCache.expiry) {
    return prCommentsCache.items;
  }

  try {
    const resolved = await getMyResolvedWorkItems();
    const withPr = resolved.filter(wi => wi.githubPrUrl).slice(0, 10);
    if (withPr.length === 0) return [];

    const username = await getGitHubUsername();
    const results: (AdoWorkItem & { commentCount: number })[] = [];

    for (const wi of withPr) {
      const match = wi.githubPrUrl!.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!match) continue;
      const [, owner, repo, prNum] = match;

      try {
        const { repository } = await octokit.graphql<{
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: {
                  isResolved: boolean;
                  comments: { nodes: { author: { login: string } | null }[] };
                }[];
              };
            };
          };
        }>(`query($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              reviewThreads(first: 100) {
                nodes {
                  isResolved
                  comments(first: 100) {
                    nodes { author { login } }
                  }
                }
              }
            }
          }
        }`, { owner, repo, prNumber: parseInt(prNum) });

        const unresolvedUnreplied = repository.pullRequest.reviewThreads.nodes.filter(thread => {
          if (thread.isResolved) return false;
          const authors = thread.comments.nodes.map(c => c.author?.login);
          // skip threads started by user, skip if user has replied
          if (authors[0] === username) return false;
          return !authors.slice(1).includes(username);
        });

        if (unresolvedUnreplied.length > 0) {
          results.push({ ...wi, commentCount: unresolvedUnreplied.length });
        }
      } catch (err) {
        console.error(`[UserItems] Error checking PR comments for ${owner}/${repo}#${prNum}:`, err);
      }
    }

    prCommentsCache = { items: results, expiry: now + PR_COMMENTS_TTL };
    console.log(`[UserItems] Found ${results.length} resolved items with PR comments`);
    return results;
  } catch (err) {
    console.error('[UserItems] Error fetching resolved items with PR comments:', err);
    return [];
  }
}

export async function getCurrentSprint(): Promise<{ path: string; name: string } | null> {
  if (!checkAdoConfig('project', 'team')) return null;

  const auth = getAdoAuth();
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

  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] UNDER '${escapeWiql(sprint.path)}' AND [System.State] = 'Reviewed' ORDER BY [System.ChangedDate] DESC`;
  const items = await fetchAdoWorkItemsByQuery(query, `Fetching reviewed items in sprint ${sprint.name}`, 100);

  // Enrich with reviewedBy field (not included in standard mapping)
  const auth = getAdoAuth();
  const reviewedByField = config.ado.reviewedByField || 'Custom.ReviewedBy';

  if (items.length > 0) {
    try {
      const detailsUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workitems?ids=${items.map(i => i.id).join(',')}&$expand=relations&api-version=7.1`;
      const detailsRes = await fetch(detailsUrl, { headers: { Authorization: `Basic ${auth}` } });
      if (detailsRes.ok) {
        const detailsData = await detailsRes.json();
        const reviewedByMap = new Map<number, string>();
        for (const wi of detailsData.value || []) {
          const fields = wi.fields || {};
          const reviewedBy = fields[reviewedByField]?.displayName || fields[reviewedByField] || '';
          if (reviewedBy) reviewedByMap.set(wi.id, reviewedBy);
        }
        for (const item of items) {
          item.reviewedBy = reviewedByMap.get(item.id) || '';
          item.iterationPath = sprint.path;
        }
      }
    } catch (err) {
      console.error('[UserItems] Error enriching reviewed items:', err);
    }
  }

  return { sprintName: sprint.name, items };
}

export type OwnerFilter = 'my' | 'unassigned' | 'all';

export async function getCurrentAndPreviousSprints(): Promise<{ current: string; previous: string } | null> {
  if (!checkAdoConfig('project', 'team')) return null;

  const auth = getAdoAuth();
  const url = `https://dev.azure.com/${config.ado.organization}/${config.ado.project}/${config.ado.team}/_apis/work/teamsettings/iterations?api-version=7.1`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      console.error(`[UserItems] Failed to get iterations (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const iterations = (data.value || [])
      .filter((it: any) => it.attributes?.startDate)
      .sort((a: any, b: any) =>
        new Date(a.attributes.startDate).getTime() - new Date(b.attributes.startDate).getTime()
      );

    if (iterations.length === 0) {
      console.log('[UserItems] No iterations found');
      return null;
    }

    // Find current sprint (now falls within start/finish dates)
    const now = Date.now();
    const currentIdx = iterations.findIndex((it: any) => {
      const start = new Date(it.attributes.startDate).getTime();
      const finish = new Date(it.attributes.finishDate).getTime();
      return now >= start && now <= finish;
    });

    if (currentIdx === -1) {
      // Fallback: use the last iteration
      const last = iterations[iterations.length - 1];
      const prev = iterations.length > 1 ? iterations[iterations.length - 2] : last;
      console.log(`[UserItems] No current sprint found, using last: ${last.path}`);
      return { current: last.path, previous: prev.path };
    }

    const current = iterations[currentIdx];
    const previous = currentIdx > 0 ? iterations[currentIdx - 1] : current;
    console.log(`[UserItems] Sprints: current=${current.path}, previous=${previous.path}`);
    return { current: current.path, previous: previous.path };
  } catch (err) {
    console.error('[UserItems] Error fetching iterations:', err);
    return null;
  }
}

export async function getWorkItemsBySprints(ownerFilter: OwnerFilter): Promise<AdoWorkItem[]> {
  const sprints = await getCurrentAndPreviousSprints();
  if (!sprints) {
    // Fallback: no sprint scoping, use existing behavior
    if (ownerFilter === 'my') return getMyAdoWorkItems();
    return [];
  }

  const cur = escapeWiql(sprints.current);
  const prev = escapeWiql(sprints.previous);
  const sprintClause = cur === prev
    ? `[System.IterationPath] UNDER '${cur}'`
    : `([System.IterationPath] UNDER '${cur}' OR [System.IterationPath] UNDER '${prev}')`;

  const ownerClauses: Record<OwnerFilter, string> = {
    my: "AND [System.AssignedTo] = @Me",
    unassigned: "AND [System.AssignedTo] = ''",
    all: '',
  };
  const ownerClause = ownerClauses[ownerFilter];

  const query = `SELECT [System.Id] FROM WorkItems WHERE ${sprintClause} ${ownerClause} AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Completed' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;

  return fetchAdoWorkItemsByQuery(query, `Fetching ${ownerFilter} work items (sprint-scoped)`);
}

export async function getCurrentAdoUser(): Promise<AdoUser | null> {
  if (!checkAdoConfig()) return null;

  const auth = getAdoAuth();
  const url = `https://dev.azure.com/${config.ado.organization}/_apis/connectionData?api-version=7.1-preview`;

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
  if (!checkAdoConfig('project', 'team')) return [];

  const auth = getAdoAuth();
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
