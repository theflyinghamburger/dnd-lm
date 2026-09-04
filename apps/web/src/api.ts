import type {
  CampaignSummary,
  CampaignTriggersResponse,
  CharacterSheet,
  DerivedSheet,
  InviteResponse,
  LoginRequest,
  PublicUser,
  RegisterRequest,
  RosterResponse,
  SessionSnapshot,
  UpdateHpRequest,
} from '@dnd-lm/contracts';

/** Thrown for any non-2xx; `code` is the server's typed error code when it sent one. */
/** Mirrors the API's CharacterView: stored inputs plus values derived on read. */
export type CharacterView = {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  sheet: CharacterSheet;
  derived: DerivedSheet;
  stateVersion: number;
};

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

const patch = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

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
  roster: (campaignId: string) => call<RosterResponse>(`/campaigns/${campaignId}/roster`),
  triggers: (campaignId: string) =>
    call<CampaignTriggersResponse>(`/campaigns/${campaignId}/triggers`),
  sessions: (campaignId: string) => call<SessionSnapshot[]>(`/campaigns/${campaignId}/sessions`),
  createSession: (campaignId: string) =>
    post<SessionSnapshot>(`/campaigns/${campaignId}/sessions`, {}),
  characters: (campaignId: string) => call<CharacterView[]>(`/campaigns/${campaignId}/characters`),
  updateHp: (campaignId: string, characterId: string, body: UpdateHpRequest) =>
    patch<CharacterView>(`/campaigns/${campaignId}/characters/${characterId}/hp`, body),
};
