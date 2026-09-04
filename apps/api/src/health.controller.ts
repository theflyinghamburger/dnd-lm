import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
