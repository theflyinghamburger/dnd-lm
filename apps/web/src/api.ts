import type {
  CampaignSummary,
  InviteResponse,
  LoginRequest,
  PublicUser,
  RegisterRequest,
} from '@dnd-lm/contracts';

/** Thrown for any non-2xx; `code` is the server's typed error code when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // The session lives in an httpOnly cookie; nothing here ever sees a token.
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new ApiError(res.status, body?.code ?? body?.message ?? `HTTP_${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => call<PublicUser>('/auth/me'),
  register: (body: RegisterRequest) => post<PublicUser>('/auth/register', body),
  login: (body: LoginRequest) => post<PublicUser>('/auth/login', body),
  logout: () => post<void>('/auth/logout'),
  campaigns: () => call<CampaignSummary[]>('/campaigns'),
  createCampaign: (name: string) => post<CampaignSummary>('/campaigns', { name }),
  createInvite: (campaignId: string) =>
    post<InviteResponse>(`/campaigns/${campaignId}/invites`, {}),
  acceptInvite: (token: string) => post<CampaignSummary>(`/invites/${token}/accept`),
};
