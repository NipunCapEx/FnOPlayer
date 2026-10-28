import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.service.js';
import { PollingWorker } from './monitoring.js';

@Injectable()
export class MonitoringRunner implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebase: FirebaseAdminService,
    @Inject(PollingWorker)
    private readonly worker: PollingWorker,
  ) {}

  getDiagnostics() {
    return this.worker.getDiagnostics();
  }

  onModuleInit(): void {
    if (this.firebase?.isConfigured) this.worker.start();
  }

  onModuleDestroy(): void {
    if (this.firebase?.isConfigured) this.worker.stop();
  }
}
