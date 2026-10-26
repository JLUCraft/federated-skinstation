import { t } from './i18n';
type ApiOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  errorMessage?: string;
};

/** A failed request; `status` lets callers explain specific cases instead of a generic refusal. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiRequest(
  path: string,
  {
    method = 'GET',
    token,
    body,
    errorMessage = t('请求未完成，请稍后重试'),
  }: ApiOptions = {},
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (body instanceof FormData) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const response = await fetch(path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const message =
      failure?.errorMessage === 'Publication requires a site administrator'
        ? t('站点尚未配置管理员，暂时无法公开材质')
        : errorMessage;
    throw new ApiError(message, response.status);
  }
  return response.status === 204 ? {} : response.json();
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : t('请求未完成，请稍后重试');
}
