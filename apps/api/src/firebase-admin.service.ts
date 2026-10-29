import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type Credential,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FirestorePort } from './firestore-port.js';

const APP_NAME = 'foplayer-api';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private app: App | null = null;
  private credential: Credential | null = null;

  get isConfigured(): boolean {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const credentialSource =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.K_SERVICE;
    return Boolean(projectId && credentialSource);
  }

  onModuleInit(): void {
    if (!this.isConfigured) return;

    const existing = getApps().find((app) => app.name === APP_NAME);
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (existing) {
      this.app = existing;
      this.credential = serviceAccountJson
        ? cert(JSON.parse(serviceAccountJson))
        : applicationDefault();
      return;
    }

    this.credential = serviceAccountJson
      ? cert(JSON.parse(serviceAccountJson) as Record<string, unknown>)
      : applicationDefault();
    const projectId = process.env.FIREBASE_PROJECT_ID;
    this.app = initializeApp(
      {
        credential: this.credential,
        ...(projectId ? { projectId } : {}),
      },
      APP_NAME,
    );
  }

  get auth(): Auth {
    if (!this.app) {
      throw new ServiceUnavailableException(
        'Firebase Admin is not configured for this environment',
      );
    }
    return getAuth(this.app);
  }

  get firestore(): FirestorePort {
    if (!this.app) {
      throw new ServiceUnavailableException(
        'Firebase Admin is not configured for this environment',
      );
    }
    const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim();
    return (databaseId
      ? getFirestore(this.app, databaseId)
      : getFirestore(this.app)) as unknown as FirestorePort;
  }

  async getAccessToken(): Promise<string> {
    if (!this.credential) {
      throw new ServiceUnavailableException(
        'Firebase server credentials are not configured',
      );
    }
    const token = await this.credential.getAccessToken();
    if (!token.access_token) {
      throw new ServiceUnavailableException(
        'Firebase credentials did not return an access token',
      );
    }
    return token.access_token;
  }
}
