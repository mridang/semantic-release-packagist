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
import { fileURLToPath } from 'url';
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
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const tmpDir = path.join(__dirname, 'verify-tmp');
    const composerJsonPath = path.join(tmpDir, 'composer.json');

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(
        composerJsonPath,
        JSON.stringify({
          name: 'test/pkg',
          description: 'A valid test package',
        }),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const baseCtx = {
      logger,
      cwd: tmpDir,
      options: {
        repositoryUrl: 'https://github.com/test-user/test-repo.git',
      },
    } as unknown as VerifyConditionsContext;

    it('should pass with valid configuration (using default composer validation)', async () => {
      // This test assumes 'composer' is in the PATH and the composer.json is valid.
      // For a pure unit test without relying on external composer,
      // you would provide a successful composerValidationCommand mock.
      await expect(
        verifyConditions(baseConfig, baseCtx),
      ).resolves.toBeUndefined();
    });

    it('should use custom composerValidationCommand and pass if it resolves', async () => {
      const customValidationCommand = jest
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
      const configWithCustomCommand: PackagistPluginConfig = {
        ...baseConfig,
        composerValidationCommand: customValidationCommand,
      };
      await expect(
        verifyConditions(configWithCustomCommand, baseCtx),
      ).resolves.toBeUndefined();
      expect(customValidationCommand).toHaveBeenCalledWith(tmpDir, logger);
    });

    it('should throw an error if custom composerValidationCommand throws', async () => {
      const customValidationCommand = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('Custom validation failed'));
      const configWithCustomCommand: PackagistPluginConfig = {
        ...baseConfig,
        composerValidationCommand: customValidationCommand,
      };
      await expect(
        verifyConditions(configWithCustomCommand, baseCtx),
      ).rejects.toThrow(/`composer.json` validation failed/);
      expect(customValidationCommand).toHaveBeenCalledWith(tmpDir, logger);
    });

    it('should throw an error if username is not provided (with custom successful validation)', async () => {
      const config: PackagistPluginConfig = {
        ...baseConfig,
        username: '',
        composerValidationCommand: jest
          .fn<() => Promise<void>>()
          .mockResolvedValue(undefined),
      };
      await expect(verifyConditions(config, baseCtx)).rejects.toThrow(
        /Packagist username is not set/,
      );
    });

    it('should throw an error if apiToken is not provided (with custom successful validation)', async () => {
      const config: PackagistPluginConfig = {
        ...baseConfig,
        apiToken: '',
        composerValidationCommand: jest
          .fn<() => Promise<void>>()
          .mockResolvedValue(undefined),
      };
      await expect(verifyConditions(config, baseCtx)).rejects.toThrow(
        /Packagist API token is not set/,
      );
    });

    it('should throw an error if repositoryUrl is not found in context (with custom successful validation)', async () => {
      const ctxNoRepoUrl = {
        ...baseCtx,
        options: {},
      } as VerifyConditionsContext;
      const configWithCustomValidCommand: PackagistPluginConfig = {
        ...baseConfig,
        composerValidationCommand: jest
          .fn<() => Promise<void>>()
          .mockResolvedValue(undefined),
      };
      await expect(
        verifyConditions(configWithCustomValidCommand, ctxNoRepoUrl),
      ).rejects.toThrow(/Repository URL could not be determined/);
    });

    it('should throw an error if composer.json is not found', async () => {
      fs.unlinkSync(composerJsonPath);
      await expect(verifyConditions(baseConfig, baseCtx)).rejects.toThrow(
        /composer.json not found/,
      );
    });
  });

  describe('prepare() with real file system', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const tmpDir = path.join(__dirname, 'prepare-tmp');
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
    });

    it('should throw a specific error for 401 Unauthorized status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Error',
      } as Response);
      await expect(publish(baseConfig, baseCtx)).rejects.toThrow(
        /Invalid Packagist credentials/,
      );
    });
  });
});
