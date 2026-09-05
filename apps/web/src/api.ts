import type {
  AdminConnection,
  CampaignDmSettings,
  CampaignSummary,
  CampaignTriggersResponse,
  CharacterSheet,
  DerivedSheet,
  InviteResponse,
  LoginRequest,
  PublicUser,
  RegisterRequest,
  ConnectionTestResult,
  CreateConnectionRequest,
  HostConnection,
  ProviderSettingsResponse,
  RosterResponse,
  SessionSnapshot,
  UpdateConnectionRequest,
  UpdateDmSettingsRequest,
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
    /**
     * The server's error body. Rejections carry their own explanation - which
     * URL was refused and why (M7.3), which campaigns still use a connection
     * (M7.4) - and the forms show *that* rather than re-deriving the rule on
     * the client, where it would drift.
     */
    readonly body: Record<string, unknown> | null = null,
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
    const body = (await res.json().catch(() => null)) as
      (Record<string, unknown> & { code?: string; message?: string }) | null;
    throw new ApiError(res.status, body?.code ?? body?.message ?? `HTTP_${res.status}`, body);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

const patch = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const del = (path: string): Promise<void> => call<void>(path, { method: 'DELETE' });

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

  /* --- Campaign settings (M7.6) --------------------------------------- */

  dmSettings: (campaignId: string) =>
    call<CampaignDmSettings>(`/campaigns/${campaignId}/dm-settings`),
  updateDmSettings: (campaignId: string, body: UpdateDmSettingsRequest) =>
    patch<CampaignDmSettings>(`/campaigns/${campaignId}/dm-settings`, body),
  /** Selecting a provider is its own write: it is validated against the
   *  enabled connections, which the knobs have nothing equivalent to (M7.4). */
  setProvider: (campaignId: string, providerConnectionId: string | null) =>
    patch<ProviderSettingsResponse>(`/campaigns/${campaignId}/provider`, { providerConnectionId }),
  /** The redacted list a host picks from: identity and model, no URL, no key. */
  providers: () => call<HostConnection[]>('/providers'),

  /* --- Admin providers (M7.6) ----------------------------------------- */

  adminProviders: () => call<AdminConnection[]>('/admin/providers'),
  createConnection: (body: CreateConnectionRequest) =>
    post<AdminConnection>('/admin/providers', body),
  updateConnection: (id: string, body: UpdateConnectionRequest) =>
    patch<AdminConnection>(`/admin/providers/${id}`, body),
  /** Write-only: a new value replaces the stored key, which is never read back. */
  replaceConnectionKey: (id: string, apiKey: string) =>
    post<AdminConnection>(`/admin/providers/${id}/key`, { apiKey }),
  testConnection: (id: string) => post<ConnectionTestResult>(`/admin/providers/${id}/test`),
  deleteConnection: (id: string) => del(`/admin/providers/${id}`),
};
