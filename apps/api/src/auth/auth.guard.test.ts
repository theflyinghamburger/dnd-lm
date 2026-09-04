import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard';
import type { AuthService } from './auth.service';

const resolveSession = vi.fn();
const auth = { resolveSession } as unknown as AuthService;

function contextFor(type: 'http' | 'ws', cookies: Record<string, string> = {}): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ cookies }) }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  const guard = new AuthGuard(auth, new Reflector());

  it('refuses an HTTP request with no session cookie', async () => {
    await expect(guard.canActivate(contextFor('http'))).rejects.toThrow(UnauthorizedException);
  });

  // Regression: as a global guard this ran on WebSocket message handlers too,
  // found no cookies on the socket, and rejected every frame (M2.2).
  it('leaves WebSocket frames alone — the socket authenticated at its handshake', async () => {
    await expect(guard.canActivate(contextFor('ws'))).resolves.toBe(true);
    expect(resolveSession).not.toHaveBeenCalled();
  });
});
