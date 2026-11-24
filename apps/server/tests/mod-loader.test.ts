import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getVehicleDefinition } from '@openstreet-racer/vehicle/catalog';
import { loadVehicleMods } from '../src/mod-loader';

const validManifest = {
  schemaVersion: 1,
  id: 'test-mod',
  name: 'Test Mod',
  version: '1.0.0',
  description: 'A test vehicle mod.',
  vehicles: [
    {
      id: 'mod-test-mod-cart',
      name: 'Test Cart',
      category: 'Community mod',
      costCents: 100,
      visual: 'sedan',
      dimensions: {
        width: 1.8,
        length: 4,
        height: 1.4,
        wheelbase: 2.6,
        track: 1.6,
        wheelRadius: 0.34,
      },
      handling: {
        massKg: 1200,
        engineForce: 6000,
        brakeForce: 9000,
        maxSpeedMps: 40,
        maxReverseMps: 5,
        steeringRadians: 0.55,
        grip: 6,
        suspensionStiffness: 30,
      },
    },
  ],
};

const mismatchedManifest = {
  ...validManifest,
  id: 'test-mod-2',
  vehicles: [
    {
      ...validManifest.vehicles[0]!,
      id: 'mod-test-mod-2-cart',
      name: 'Other Cart',
    },
  ],
};

let directory = '';

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('loadVehicleMods', () => {
  it('loads a valid mod folder and registers its vehicles', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'test-mod');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(validManifest));

    const mods = await loadVehicleMods(directory);

    expect(mods).toHaveLength(1);
    expect(mods[0]!.id).toBe('test-mod');
    expect(getVehicleDefinition('mod-test-mod-cart').name).toBe('Test Cart');
  });

  it('skips folders whose manifest ID does not match the folder name', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'wrong-folder');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(mismatchedManifest));

    const mods = await loadVehicleMods(directory);

    expect(mods).toHaveLength(0);
    expect(getVehicleDefinition('mod-test-mod-2-cart').name).not.toBe('Other Cart');
  });

  it('skips folders with invalid JSON and treats a missing directory as empty', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'broken');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), '{not json');

    expect(await loadVehicleMods(directory)).toHaveLength(0);
    expect(await loadVehicleMods(join(directory, 'missing'))).toHaveLength(0);
  });
});
