import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SessionController } from './session.controller';
import { SessionGateway } from './session.gateway';
import { SessionService } from './session.service';

@Module({
  imports: [AuthModule, CampaignsModule],
  controllers: [SessionController],
  providers: [SessionService, SessionGateway],
  exports: [SessionService],
})
export class SessionModule {}
