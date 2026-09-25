type ApiOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  errorMessage?: string;
};

export async function apiRequest(path: string, {method = 'GET', token, body, errorMessage = '请求未完成，请稍后重试'}: ApiOptions = {}) {
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
  const response = await fetch(path, {method, headers, ...(payload === undefined ? {} : {body: payload})});
  if (!response.ok) throw new Error(errorMessage);
  return response.status === 204 ? {} : response.json();
}
