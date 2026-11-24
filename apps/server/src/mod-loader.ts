import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';
import { registerVehicleMod, type VehicleModManifest } from '@openstreet-racer/vehicle/catalog';

export async function loadVehicleMods(directory: string): Promise<readonly VehicleModManifest[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const loaded: VehicleModManifest[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    try {
      const path = join(directory, entry.name, 'manifest.json');
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(value) || value.id !== entry.name) {
        throw new Error('Mod ID must match its folder name.');
      }
      loaded.push(registerVehicleMod(value));
    } catch (error) {
      console.warn(`Skipping invalid vehicle mod folder '${entry.name}'.`, error);
    }
  }
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
