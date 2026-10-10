import type {
  ApiErrorBody,
  ArchitectureResponse,
  AskResponse,
  FileContentResponse,
  FileListResponse,
  HealthResponse,
  ImportersResponse,
  RepoListResponse,
  RepoSummary,
  SearchResponse,
  SessionResponse,
  SymbolsResponse,
  UploadBatchRequest,
  UploadBatchResponse,
  UploadStatusResponse,
} from '../../shared/api.ts'
import type { Discovery } from '../../shared/discovery.ts'
import type { UploadManifest } from '../../shared/zip/manifest.ts'

/**
 * A failed API call with a message that is safe to render. Server messages are
 * user-safe by contract (see shared/api.ts); client-side failures use fixed text.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

/** Fired when any call gets 401, so the app can return to the sign-in screen. */
export const SESSION_EXPIRED_EVENT = 'repomind:session-expired'

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(0, 'network_error', "Couldn't reach the RepoMind server. Check your connection and try again.", null)
  }
  if (response.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  return readResponse<T>(response)
}

async function readResponse<T>(response: Response): Promise<T> {
  const requestId = response.headers.get('X-Request-Id')
  const unexpected = new ApiError(response.status, 'unexpected_response', 'The server sent an unexpected response. Try again in a moment.', requestId)
  if (!(response.headers.get('Content-Type') ?? '').startsWith('application/json')) throw unexpected
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw unexpected
  }
  if (response.ok) return body as T
  if (isApiErrorBody(body)) throw new ApiError(response.status, body.error.code, body.error.message, body.error.requestId)
  throw unexpected
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = (value as { error: unknown }).error
  return typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string'
}

const repoPath = (id: string) => `/api/repos/${encodeURIComponent(id)}`

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('GET', '/api/health', undefined, signal),
  session: () => request<SessionResponse>('GET', '/api/auth/session'),
  login: (code: string) => request<SessionResponse>('POST', '/api/auth/login', { code }),
  logout: () => request<SessionResponse>('POST', '/api/auth/logout', {}),
  listRepos: () => request<RepoListResponse>('GET', '/api/repos'),
  addRepo: (url: string, discovery: Discovery) => request<RepoSummary>('POST', '/api/repos', { url, discovery }),
  getRepo: (id: string) => request<RepoSummary>('GET', repoPath(id)),
  step: (id: string) => request<{ outcome: { kind: string }; repo: RepoSummary }>('POST', `${repoPath(id)}/step`, {}),
  reindex: (id: string, discovery: Discovery) => request<RepoSummary>('POST', `${repoPath(id)}/reindex`, { discovery }),
  deleteRepo: (id: string) => request<{ deleted: boolean }>('DELETE', repoPath(id)),
  files: (id: string) => request<FileListResponse>('GET', `${repoPath(id)}/files`),
  file: (id: string, path: string) => request<FileContentResponse>('GET', `${repoPath(id)}/file?path=${encodeURIComponent(path)}`),
  search: (id: string, q: string) => request<SearchResponse>('GET', `${repoPath(id)}/search?q=${encodeURIComponent(q)}`),
  ask: (id: string, question: string) => request<AskResponse>('POST', `${repoPath(id)}/ask`, { question }),
  symbols: (id: string, q: string) => request<SymbolsResponse>('GET', `${repoPath(id)}/symbols?q=${encodeURIComponent(q)}`),
  importers: (id: string, path: string) => request<ImportersResponse>('GET', `${repoPath(id)}/importers?path=${encodeURIComponent(path)}`),
  architecture: (id: string) => request<ArchitectureResponse>('GET', `${repoPath(id)}/architecture`),
  createUpload: (manifest: UploadManifest) => request<RepoSummary>('POST', '/api/uploads', manifest),
  newUploadVersion: (id: string, manifest: UploadManifest) => request<RepoSummary>('POST', `${repoPath(id)}/upload`, manifest),
  uploadStatus: (id: string) => request<UploadStatusResponse>('GET', `${repoPath(id)}/upload`),
  uploadFiles: (id: string, batch: UploadBatchRequest, signal?: AbortSignal) => request<UploadBatchResponse>('POST', `${repoPath(id)}/upload/files`, batch, signal),
  cancelUpload: (id: string, versionId: string) => request<RepoSummary>('POST', `${repoPath(id)}/upload/cancel`, { versionId }),
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : 'Something unexpected happened. Try again.'
}
