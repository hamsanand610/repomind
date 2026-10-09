import type { ApiErrorBody, HealthResponse } from '../../shared/api.ts'

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

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/api/health', signal)
}

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(
      0,
      'network_error',
      "Couldn't reach the RepoMind server. Check your connection and try again.",
      null,
    )
  }
  return readResponse<T>(response)
}

async function readResponse<T>(response: Response): Promise<T> {
  const requestId = response.headers.get('X-Request-Id')
  const unexpected = new ApiError(
    response.status,
    'unexpected_response',
    'The server sent an unexpected response. Try again in a moment.',
    requestId,
  )

  if (!(response.headers.get('Content-Type') ?? '').startsWith('application/json')) throw unexpected

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw unexpected
  }

  if (response.ok) return body as T
  if (isApiErrorBody(body)) {
    throw new ApiError(response.status, body.error.code, body.error.message, body.error.requestId)
  }
  throw unexpected
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = (value as { error: unknown }).error
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).message === 'string'
  )
}
