import path from 'node:path';
import { z } from 'zod';
import type { NexusFlowConfig } from '../types.js';
import { HARNESS_IDS } from '../harnesses/registry.js';

const absDir = z
  .string()
  .trim()
  .min(1)
  .refine((v) => path.isAbsolute(v), { message: 'must be an absolute path' })
  .refine((v) => {
    const resolved = path.resolve(v);
    const parsed = path.parse(resolved);
    return resolved !== parsed.root;
  }, { message: 'must not be a filesystem root' });

/**
 * The settings the app itself edits, and so the only ones POST /api/config takes from a client.
 *
 * The GUI posts the whole config object back rather than a diff, so keys outside this schema are
 * dropped silently (zod strips unknown keys) instead of rejected: the stored value stays as it was.
 * That covers the server-owned keys (`version` and the update-check fields) and anything the GUI
 * only echoes (`plugins`, `excludePatterns`). Those change through the CLI or by editing the file.
 */
export const configPatchSchema = z
  .object({
    devDir: absDir.optional(),
    workspacesDir: absDir.optional(),
    defaultAssistant: z.enum(HARNESS_IDS).nullable().optional(),
    defaultEditor: z.string().nullable().optional(),
    scanDepth: z.number().int().min(1).max(10).optional(),
    storageProvider: z.string().min(1).optional(),
    adapterConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strip();

/**
 * Every key of `NexusFlowConfig`, and so every key allowed to reach ~/.nexusflow/config.json.
 * Typed as a complete record: adding a key to the interface without listing it here is a compile
 * error, so a new setting cannot be silently dropped on save.
 */
const PERSISTED_CONFIG_KEYS: Record<keyof NexusFlowConfig, true> = {
  version: true,
  devDir: true,
  workspacesDir: true,
  defaultAssistant: true,
  defaultEditor: true,
  scanDepth: true,
  excludePatterns: true,
  storageProvider: true,
  adapterConfig: true,
  plugins: true,
  lastUpdateCheck: true,
  latestVersion: true,
  latestDownloadUrl: true,
  latestReleaseNotes: true,
};

/** The config reduced to the keys that may be stored. Keeps the original key order. */
export function toPersistedConfig(config: NexusFlowConfig): NexusFlowConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => Object.hasOwn(PERSISTED_CONFIG_KEYS, key)),
  ) as unknown as NexusFlowConfig;
}
