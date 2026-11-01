export class ProviderStageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function retryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function retryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds))
    return Math.min(30_000, Math.max(0, seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date)
    ? Math.min(30_000, Math.max(0, date - Date.now()))
    : undefined;
}
