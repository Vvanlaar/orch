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
  project: string;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
  githubPrUrl?: string;
  testNotes?: string;
  body?: string;
}

export async function getMyGitHubPRs(): Promise<GitHubPR[]> {
  if (!config.github.token) {
    console.log('[UserItems] No GITHUB_TOKEN configured');
    return [];
  }

  const prs: GitHubPR[] = [];

  try {
    // Get current user
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`[UserItems] Fetching PRs for GitHub user: ${user.login}`);
    const username = user.login;

    // PRs authored by me - use graphql or REST pulls endpoint
    // Using REST search with type:pr instead of deprecated issuesAndPullRequests
    const authoredRes = await fetch(
      `https://api.github.com/search/issues?q=is:pr+is:open+author:${username}&sort=updated&order=desc&per_page=20`,
      { headers: { Authorization: `token ${config.github.token}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const authored = await authoredRes.json();

    for (const pr of authored.items || []) {
      const repoParts = pr.repository_url.split('/');
      const repo = `${repoParts[repoParts.length - 2]}/${repoParts[repoParts.length - 1]}`;
      prs.push({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft || false,
        repo,
        url: pr.html_url,
        author: pr.user?.login || '',
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        role: 'author',
      });
    }

    // PRs where I'm requested as reviewer
    const reviewingRes = await fetch(
      `https://api.github.com/search/issues?q=is:pr+is:open+review-requested:${username}&sort=updated&order=desc&per_page=20`,
      { headers: { Authorization: `token ${config.github.token}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const reviewing = await reviewingRes.json();

    for (const pr of reviewing.items || []) {
      // Skip if already added as author
      if (prs.some(p => p.url === pr.html_url)) continue;

      const repoParts = pr.repository_url.split('/');
      const repo = `${repoParts[repoParts.length - 2]}/${repoParts[repoParts.length - 1]}`;
      prs.push({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft || false,
        repo,
        url: pr.html_url,
        author: pr.user?.login || '',
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        role: 'reviewer',
      });
    }

    // Sort by updated date
    prs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    console.log(`[UserItems] Found ${prs.length} GitHub PRs`);
  } catch (err) {
    console.error('[UserItems] Error fetching GitHub PRs:', err);
  }

  return prs;
}

export async function getMyAdoWorkItems(): Promise<AdoWorkItem[]> {
  if (!config.ado.pat) {
    console.log('[UserItems] No ADO_PAT configured');
    return [];
  }
  if (!config.ado.organization) {
    console.log('[UserItems] No ADO_ORG configured');
    return [];
  }

  console.log(`[UserItems] Fetching work items from ADO org: ${config.ado.organization}`);
  const items: AdoWorkItem[] = [];
  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');

  try {
    // WIQL query for work items assigned to me
    const wiqlUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/wiql?api-version=7.1`;

    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Completed' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`,
      }),
    });

    if (!wiqlRes.ok) {
      const errText = await wiqlRes.text();
      console.error(`[UserItems] ADO WIQL failed (${wiqlRes.status}):`, errText);
      return items;
    }

    const wiqlData = await wiqlRes.json();
    const workItemIds = (wiqlData.workItems || []).slice(0, 30).map((w: { id: number }) => w.id);
    console.log(`[UserItems] ADO WIQL returned ${workItemIds.length} work item IDs`);

    if (workItemIds.length === 0) return items;

    // Fetch work item details
    const idsParam = workItemIds.join(',');
    const detailsUrl = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workitems?ids=${idsParam}&api-version=7.1`;

    const detailsRes = await fetch(detailsUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!detailsRes.ok) {
      console.error(`[UserItems] ADO details fetch failed (${detailsRes.status}):`, await detailsRes.text());
      return items;
    }

    const detailsData = await detailsRes.json();

    for (const wi of detailsData.value || []) {
      const fields = wi.fields || {};

      // Look for resolution in various possible fields
      const resolution = fields['Microsoft.VSTS.Common.Resolution']
        || fields['System.Description']
        || '';

      // Look for GitHub PR URL in various fields or extract from resolution/description
      let githubPrUrl = '';
      const allText = JSON.stringify(fields);
      const prMatch = allText.match(/https:\/\/github\.com\/[^"'\s]+\/pull\/\d+/);
      if (prMatch) githubPrUrl = prMatch[0];

      // Look for test notes in various possible fields
      const testNotes = fields['Microsoft.VSTS.TCM.TestNotes']
        || fields['Microsoft.VSTS.Common.AcceptanceCriteria']
        || fields['Custom.TestNotes']
        || '';

      items.push({
        id: wi.id,
        title: fields['System.Title'] || 'Untitled',
        state: fields['System.State'] || 'Unknown',
        type: fields['System.WorkItemType'] || 'Item',
        url: `https://dev.azure.com/${config.ado.organization}/${fields['System.TeamProject'] || '_'}/_workitems/edit/${wi.id}`,
        assignedTo: fields['System.AssignedTo']?.displayName || '',
        project: fields['System.TeamProject'] || '',
        createdAt: fields['System.CreatedDate'] || '',
        updatedAt: fields['System.ChangedDate'] || '',
        resolution,
        githubPrUrl,
        testNotes,
        body: fields['System.Description'] || '',
      });
    }

    console.log(`[UserItems] Found ${items.length} ADO work items`);
  } catch (err) {
    console.error('[UserItems] Error fetching ADO work items:', err);
  }

  return items;
}
