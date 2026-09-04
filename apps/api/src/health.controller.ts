import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
