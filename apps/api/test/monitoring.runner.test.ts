import { describe, expect, it, vi } from 'vitest';
import { FirebaseAdminService } from '../src/firebase-admin.service.js';
import { MonitoringRunner } from '../src/monitoring.runner.js';
import { PollingWorker } from '../src/monitoring.js';

describe('MonitoringRunner', () => {
  it('starts polling only when Firebase runtime is configured', () => {
    const worker = { start: vi.fn(), stop: vi.fn(), stopAndDrain: vi.fn(async () => {}) };
    const firebase = { isConfigured: false } as FirebaseAdminService;
    const runner = new MonitoringRunner(
      firebase,
      worker as unknown as PollingWorker,
    );

    runner.onModuleInit();
    expect(worker.start).not.toHaveBeenCalled();
    await runner.onModuleDestroy();
    expect(worker.stopAndDrain).not.toHaveBeenCalled();
  });

  it('starts the worker when Firebase is configured', () => {
    const worker = { start: vi.fn(), stop: vi.fn() };
    const firebase = { isConfigured: true } as FirebaseAdminService;
    const runner = new MonitoringRunner(
      firebase,
      worker as unknown as PollingWorker,
    );

    runner.onModuleInit();
    expect(worker.start).toHaveBeenCalledOnce();
    runner.onModuleDestroy();
    expect(worker.stopAndDrain).toHaveBeenCalledOnce();
  });
});
