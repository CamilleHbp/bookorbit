import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FanfictionJobService } from './fanfiction-job.service';

@Injectable()
export class FanfictionSchedulerService {
  private readonly logger = new Logger(FanfictionSchedulerService.name);
  private running = false;
  constructor(private readonly jobs: FanfictionJobService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const count = await this.jobs.enqueueDue();
      if (count) this.logger.log(`[fanfiction.schedule] [end] durationMs=${Date.now() - startedAt} queued=${count} - due story checks queued`);
    } catch {
      this.logger.warn(`[fanfiction.schedule] [fail] durationMs=${Date.now() - startedAt} errorClass=QueueError - story scheduling failed`);
    } finally {
      this.running = false;
    }
  }
}
