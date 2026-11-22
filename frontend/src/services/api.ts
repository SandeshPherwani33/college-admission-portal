const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiOrigin = configuredApiUrl
  ? (/^https?:\/\//i.test(configuredApiUrl) ? configuredApiUrl : `https://${configuredApiUrl}`)
  : null;
export const API_BASE_URL = apiOrigin
  ? `${apiOrigin.replace(/\/+$/, '').replace(/\/api$/i, '')}/api`
  : 'http://127.0.0.1:8000/api';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isMultipartBody = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(isMultipartBody ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let message = errorBody || 'Request failed';
    try {
      const parsed = JSON.parse(errorBody);
      const detail = parsed.detail;
      if (typeof detail === 'string') {
        message = detail;
      } else if (typeof detail?.message === 'string') {
        message = detail.message;
      }
    } catch {
      // Keep the original response text when the server does not return JSON.
    }
    if (response.status === 401) {
      sessionStorage.removeItem('uniapply-token');
      window.dispatchEvent(new CustomEvent('uniapply:session-expired'));
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiUpload<T>(
  path: string,
  body: FormData,
  headers: Record<string, string>,
  onProgress: (progress: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE_URL}${path}`);
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('error', () => reject(new Error('Network error while uploading the document.')));
    request.addEventListener('abort', () => reject(new Error('Document upload was cancelled.')));
    request.addEventListener('load', () => {
      if (request.status < 200 || request.status >= 300) {
        let message = request.responseText || 'Document upload failed.';
        try {
          const parsed = JSON.parse(request.responseText);
          const detail = parsed.detail;
          if (typeof detail === 'string') {
            message = detail;
          } else if (typeof detail?.message === 'string') {
            message = detail.message;
          }
        } catch {
          // Keep the response text when the server does not return JSON.
        }
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText) as T);
      } catch {
        reject(new Error('The server returned an invalid upload response.'));
      }
    });
    request.send(body);
  });
}
