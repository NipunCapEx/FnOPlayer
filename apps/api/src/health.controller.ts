import { Controller, Get } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.service.js';
import { marketHoursPolicyFromEnvironment } from './monitoring.js';

@Controller()
export class HealthController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  @Get('health')
  getHealth() {
    const firebaseConfigured = this.firebase?.isConfigured ?? false;
    const marketHoursConfigurationValid =
      marketHoursPolicyFromEnvironment() !== null;
    const telegramConfigured = Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_CHAT_ID &&
        (process.env.FIREBASE_ALLOWED_UIDS ?? '')
          .split(',')
          .map((uid) => uid.trim())
          .filter(Boolean).length === 1,
    );

    return {
      // Keep this endpoint suitable for liveness probes: configuration issues
      // should be visible without causing an otherwise-running API to restart.
      status: 'ok',
      service: 'foplayer-api',
      firebaseConfigured,
      marketHoursConfigurationValid,
      marketDataAdapter: 'yahoo-finance-prototype',
      telegramConfigured,
      // This describes the configured FCM transport, not end-to-end delivery.
      // Device-token registration and an actual push delivery are not probed here.
      androidPushConfigured: firebaseConfigured,
      notificationReadiness: {
        telegram: {
          configured: telegramConfigured,
          readiness:
            telegramConfigured ? 'transport_configured' : 'not_configured',
        },
        androidPush: {
          transportConfigured: firebaseConfigured,
          deviceRegistration: 'not_checked',
          delivery: 'not_checked',
          readiness: firebaseConfigured
            ? 'transport_configured_delivery_unverified'
            : 'not_configured',
        },
      },
      monitoringReadiness: {
        marketHoursConfigurationValid,
        marketDataAdapter: 'yahoo-finance-prototype',
        liveProviderConnectivity: 'not_checked',
        workerRunning: 'not_exposed',
      },
    };
  }
}
