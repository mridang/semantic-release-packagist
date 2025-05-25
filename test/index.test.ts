import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url'; // <-- 1. ADD THIS IMPORT
import { verifyConditions, prepare, publish } from '../src/index.js';
import type {
  VerifyConditionsContext,
  PrepareContext,
  PublishContext,
} from 'semantic-release';
import type { PackagistPluginConfig } from '../src/index.js';

const mockFetch = jest.spyOn(global, 'fetch');

describe('semantic-release-packagist plugin', () => {
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };
  const baseConfig: PackagistPluginConfig = {
    username: 'test-user',
    apiToken: 'test-token',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('verifyConditions()', () => {
    // ... This section is correct and unchanged ...
    const baseCtx = {
      logger,
      options: {
        repositoryUrl: 'https://github.com/test-user/test-repo.git',
      },
    } as unknown as VerifyConditionsContext;

    it('should pass with valid configuration', async () => {
      await expect(
        verifyConditions(baseConfig, baseCtx),
      ).resolves.toBeUndefined();
    });

    it('should throw an error if username is not provided', async () => {
      const config = { ...baseConfig, username: '' };
      await expect(verifyConditions(config, baseCtx)).rejects.toThrow(
        /Packagist username is not set/,
      );
    });

    it('should throw an error if apiToken is not provided', async () => {
      const config = { ...baseConfig, apiToken: '' };
      await expect(verifyConditions(config, baseCtx)).rejects.toThrow(
        /Packagist API token is not set/,
      );
    });

    it('should throw an error if repositoryUrl is not found in context', async () => {
      const ctx = { ...baseCtx, options: {} } as VerifyConditionsContext;
      await expect(verifyConditions(baseConfig, ctx)).rejects.toThrow(
        /Repository URL could not be determined/,
      );
    });
  });

  describe('prepare() with real file system', () => {
    // --- 2. THIS IS THE FIX ---
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const tmpDir = path.join(__dirname, 'tmp-test-project');
    // -------------------------
    const composerJsonPath = path.join(tmpDir, 'composer.json');

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const baseCtx = {
      logger,
      cwd: tmpDir,
      nextRelease: { version: '2.0.0' },
    } as unknown as PrepareContext;
    const initialComposerJson = {
      name: 'test-user/test-repo',
      version: '1.0.0',
    };

    it('should update the version in composer.json', async () => {
      fs.writeFileSync(composerJsonPath, JSON.stringify(initialComposerJson));
      await prepare(baseConfig, baseCtx);
      const updatedContent = fs.readFileSync(composerJsonPath, 'utf-8');
      const updatedJson = JSON.parse(updatedContent);
      expect(updatedJson.version).toBe('2.0.0');
    });

    it('should throw an error if composer.json does not exist', async () => {
      await expect(prepare(baseConfig, baseCtx)).rejects.toThrow(
        /composer.json not found during prepare step/,
      );
    });
  });

  describe('publish()', () => {
    // ... This section is correct and unchanged ...
    const baseCtx = {
      logger,
      options: {
        repositoryUrl: 'https://github.com/test-user/test-repo.git',
      },
    } as unknown as PublishContext;

    it('should make a successful API call to Packagist', async () => {
      mockFetch.mockResolvedValue({ ok: true } as Response);

      await publish(baseConfig, baseCtx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        `https://packagist.org/api/update-package?username=${baseConfig.username}&apiToken=${baseConfig.apiToken}`,
        expect.any(Object),
      );
    });

    it('should throw a specific error for 401 Unauthorized status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid token',
      } as Response);

      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /Invalid Packagist credentials/,
      );
    });

    it('should throw a specific error for 403 Forbidden status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      } as Response);

      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /Invalid Packagist credentials/,
      );
    });

    it('should throw a specific error for 404 Not Found status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Package not found',
      } as Response);

      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /Packagist package not found/,
      );
    });

    it('should throw a generic error for other non-ok statuses like 500', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      } as Response);

      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /Failed to notify Packagist/,
      );
    });

    it('should throw a wrapped error for a network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /An unexpected error occurred/,
      );
    });
  });
});
