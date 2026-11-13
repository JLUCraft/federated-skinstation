import { t } from './i18n';
const ERROR_MESSAGES: Record<string, string> = {
  'Set a local password or passkey before unlinking MUA': t('请先设置本地密码或通行密钥'),
  'Sign in to your existing account to link MUA': t('请登录已有账号后关联MUA'),
  'Reconnect MUA from your local account': t('请在本地账号中重新关联MUA'),
  'MUA identity belongs to another account': t('MUA身份已关联其他账号'),
  'MUA sign-in expired': t('MUA登录已过期'),
  'Publication requires a site administrator': t('站点尚未配置管理员，暂时无法公开材质'),
  'An active site administrator must remain': t('至少保留一位有效的站点管理员'),
  'Local authority required': t('没有执行此操作的权限'),
  'Active club membership required': t('请重新验证学校邮箱'),
  'Account disabled': t('账号已停用'),
  'Credentials changed; sign in again': t('登录凭据已更新，请重新登录'),
  'Self-nomination requires chair or site administrator authority': t(
    '仅现任会长或站点管理员可以提名自己',
  ),
  'Recovery belongs to the account home club': t('请联系账号所属社团处理恢复'),
  'Site administrator required to recover global authority': t('此账号需要站点管理员恢复'),
  'Active recovery membership required': t('恢复账号的成员资格已撤销'),
  'Invalid recovery confirmation': t('恢复验证码无效或已过期'),
  'Invalid or expired recovery confirmation': t('恢复验证码无效或已过期'),
  'Recovery email already in use': t('该邮箱已被其他账号使用'),
};
type ApiOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  errorMessage?: string;
  signal?: AbortSignal;
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

export async function apiRequest<Result = unknown>(
  path: string,
  {
    method = 'GET',
    token,
    body,
    errorMessage = t('请求未完成，请稍后重试'),
    signal,
  }: ApiOptions = {},
): Promise<Result> {
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
    ...(signal ? { signal } : {}),
    ...(payload === undefined ? {} : { body: payload }),
  });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    const message =
      failure !== null &&
      typeof failure === 'object' &&
      'errorMessage' in failure &&
      typeof failure.errorMessage === 'string' &&
      Object.hasOwn(ERROR_MESSAGES, failure.errorMessage)
        ? ERROR_MESSAGES[failure.errorMessage]
        : errorMessage;
    throw new ApiError(message, response.status);
  }
  return (response.status === 204 ? {} : await response.json()) as Result;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : t('请求未完成，请稍后重试');
}
