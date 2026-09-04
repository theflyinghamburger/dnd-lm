import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { LoginRequest, type PublicUser, RegisterRequest } from '@dnd-lm/contracts';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService, SESSION_COOKIE } from './auth.service';
import type { AuthedRequest } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const user = await this.auth.register(body);
    await this.setSession(res, user.id);
    return user;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const user = await this.auth.login(body);
    await this.setSession(res, user.id);
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) await this.auth.revokeSession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: PublicUser): PublicUser {
    return user;
  }

  private async setSession(res: Response, userId: string): Promise<void> {
    const { token, expiresAt } = await this.auth.issueSession(userId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: expiresAt,
      path: '/',
    });
  }
}
