import { type Discovery, MAX_DISCOVERY_FILES, indexableCandidates } from '../../shared/discovery.ts'

/**
 * Repository discovery from the browser, using the visitor's own GitHub API
 * allowance (Cloudflare's shared server IPs exhaust GitHub's anonymous limit).
 * Only public data is requested and no credentials are sent. The server
 * re-validates the result and downloads file content itself, pinned to the commit.
 */

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

const API = 'https://api.github.com'

async function github(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, { headers: { Accept: accept }, credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch {
    throw new DiscoveryError("Couldn't reach GitHub. Check your connection and try again.")
  }
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' later'
    throw new DiscoveryError(`GitHub's API limit for your network has been reached. Try again${when}.`)
  }
  return response
}

export async function discoverRepository(
  owner: string,
  repo: string,
  ref: string | null,
  onProgress: (message: string) => void,
): Promise<Discovery> {
  const enc = encodeURIComponent
  onProgress('Checking the repository on GitHub…')
  const infoResponse = await github(`/repos/${enc(owner)}/${enc(repo)}`)
  if (infoResponse.status === 404) throw new DiscoveryError('Repository not found. It may be private; RepoMind only reads public repositories.')
  if (!infoResponse.ok) throw new DiscoveryError(`GitHub responded with HTTP ${infoResponse.status}.`)
  const info = (await infoResponse.json()) as { name: string; owner: { login: string }; default_branch: string; private: boolean; visibility?: string }
  if (info.private || (info.visibility && info.visibility !== 'public')) throw new DiscoveryError('Only public repositories can be indexed.')

  const targetRef = ref ?? info.default_branch
  onProgress(`Pinning the latest commit on ${targetRef}…`)
  const shaResponse = await github(`/repos/${enc(info.owner.login)}/${enc(info.name)}/commits/${enc(targetRef)}`, 'application/vnd.github.sha')
  if (shaResponse.status === 404 || shaResponse.status === 422) throw new DiscoveryError(`Branch or tag "${targetRef}" was not found.`)
  if (!shaResponse.ok) throw new DiscoveryError(`GitHub responded with HTTP ${shaResponse.status}.`)
  const commitSha = (await shaResponse.text()).trim()
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new DiscoveryError('GitHub returned an unexpected commit identifier.')

  onProgress('Listing files…')
  const treeResponse = await github(`/repos/${enc(info.owner.login)}/${enc(info.name)}/git/trees/${commitSha}?recursive=1`)
  if (treeResponse.status === 409) throw new DiscoveryError('This repository is empty.')
  if (!treeResponse.ok) throw new DiscoveryError(`GitHub responded with HTTP ${treeResponse.status}.`)
  const tree = (await treeResponse.json()) as { tree: Array<Record<string, unknown>>; truncated?: boolean }
  const files = indexableCandidates(tree.tree)
  if (files.length > MAX_DISCOVERY_FILES) {
    throw new DiscoveryError(
      `This repository has ${files.length.toLocaleString()} supported files; the free-tier limit is ${MAX_DISCOVERY_FILES.toLocaleString()}. Try a smaller repository.`,
    )
  }
  return {
    owner: info.owner.login,
    repo: info.name,
    defaultBranch: info.default_branch,
    ref: targetRef,
    commitSha,
    treeEntries: tree.tree.length,
    truncated: tree.truncated === true,
    files,
  }
}
