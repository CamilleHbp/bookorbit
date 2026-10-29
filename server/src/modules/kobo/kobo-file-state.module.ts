import { Module } from '@nestjs/common';
import { KoboFileStateService } from './kobo-file-state.service';

@Module({ providers: [KoboFileStateService], exports: [KoboFileStateService] })
export class KoboFileStateModule {}
