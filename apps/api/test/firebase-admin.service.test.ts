import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { FirebaseAdminService } from '../src/firebase-admin.service.js';

const environmentKeys = [
  'FIREBASE_PROJECT_ID',
  'FIRESTORE_DATABASE_ID',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'K_SERVICE',
] as const;
const originalEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('FirebaseAdminService', () => {
  it('does not initialize or expose privileged clients when configuration is missing', async () => {
    for (const key of environmentKeys) delete process.env[key];
    const service = new FirebaseAdminService();

    expect(service.isConfigured).toBe(false);
    expect(() => service.onModuleInit()).not.toThrow();
    expect(() => service.auth).toThrow(ServiceUnavailableException);
    expect(() => service.firestore).toThrow(ServiceUnavailableException);
    await expect(service.getAccessToken()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('supports an optional named Firestore database without making it required for configuration', () => {
    for (const key of environmentKeys) delete process.env[key];
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/not-read-by-this-test.json';
    process.env.FIRESTORE_DATABASE_ID = 'market-data-db';

    expect(new FirebaseAdminService().isConfigured).toBe(true);
    expect(process.env.FIRESTORE_DATABASE_ID).toBe('market-data-db');
  });

  it('requires both a project ID and a server credential source', () => {
    for (const key of environmentKeys) delete process.env[key];
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    expect(new FirebaseAdminService().isConfigured).toBe(false);

    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/not-read-by-this-test.json';
    expect(new FirebaseAdminService().isConfigured).toBe(true);
    delete process.env.FIREBASE_PROJECT_ID;
    expect(new FirebaseAdminService().isConfigured).toBe(false);
  });
});
