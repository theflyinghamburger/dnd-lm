/**
 * BaseUrlService — the DI seam M7.4 (create/update endpoints) and M7.7
 * (provider construction) validate base URLs through. Thin over the pure
 * `checkBaseUrl` so the SSRF rules live, and are unit-tested, in `base-url`.
 */
import { Injectable } from '@nestjs/common';
import { checkBaseUrl, providerUrlEnv, UrlVerdict } from './base-url';

@Injectable()
export class BaseUrlService {
  /**
   * Validate a user-supplied base URL against the deployment's SSRF policy.
   * Returns the verdict; callers map a refusal to their 400/422 and message.
   */
  async validate(rawUrl: string): Promise<UrlVerdict> {
    return checkBaseUrl(rawUrl, providerUrlEnv());
  }
}
