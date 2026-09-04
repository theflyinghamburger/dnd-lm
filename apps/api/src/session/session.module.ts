import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CharactersModule } from '../characters/characters.module';
import { DmModule } from '../dm/dm.module';
import { RouterModule } from '../router/router.module';
import { SessionController } from './session.controller';
import { SessionGateway } from './session.gateway';
import { SessionService } from './session.service';

@Module({
  // The DM module imports this one for the session service; this import
  // closes the cycle and the gateway's `forwardRef` inject resolves it.
  imports: [
    AuthModule,
    CampaignsModule,
    RouterModule,
    CharactersModule,
    forwardRef(() => DmModule),
  ],
  controllers: [SessionController],
  providers: [SessionService, SessionGateway],
  exports: [SessionService],
})
export class SessionModule {}
