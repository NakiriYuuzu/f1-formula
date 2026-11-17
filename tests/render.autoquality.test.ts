/**
 * Automatic quality: the first pick from the WebGL renderer string, the one-way step down, and which recorded pick
 * survives a restart (same GPU) or is dropped (another GPU).
 */
import { describe, expect, test } from 'bun:test';
import type { QualityLevel } from '../src/core/types';
import { defaultSettings, sanitizeSettings } from '../src/meta/save';
import { autoRecordKey, bootQuality, canvasMsaaOutlivesStep, guessQuality, isSoftwareGpu, lowerQuality, parseAutoRecord } from '../src/render/core/autoQuality';

const ANGLE = (vendor: string, name: string): string => `ANGLE (${vendor}, ${name}, Unspecified Version)`;

const INTEL_XE = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';

/** The table before the device form existed (HEAD 8d3f469), tier by tier. */
const DESKTOP_TIERS: [string, QualityLevel][] = [
  [ANGLE('Apple', 'ANGLE Metal Renderer: Apple M2 Pro'), 'high'],
  ['Apple GPU', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GT 710 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  [INTEL_XE, 'medium'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
  ['Mali-G78', 'low'],
  ['Adreno (TM) 740', 'low'],
  ['', 'medium'],
];

describe('guessQuality', () => {
  test('software rasterisers start at low', () => {
    expect(guessQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)')).toBe('low');
    expect(guessQuality('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(guessQuality('Microsoft Basic Render Driver')).toBe('low');
    expect(isSoftwareGpu('Google SwiftShader')).toBe(true);
    expect(isSoftwareGpu('Apple M2 Pro')).toBe(false);
  });

  test('Apple silicon and current discrete cards start at high', () => {
    expect(guessQuality(ANGLE('Apple', 'ANGLE Metal Renderer: Apple M2 Pro'))).toBe('high');
    expect(guessQuality(ANGLE('Apple', 'ANGLE Metal Renderer: Apple M1'))).toBe('high');
    expect(guessQuality('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(guessQuality('ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(guessQuality('ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(guessQuality('ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
  });

  test('integrated GPUs by generation', () => {
    expect(guessQuality('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(guessQuality('ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(guessQuality('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
    expect(guessQuality('ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('low');
    expect(guessQuality('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
  });

  test('old discrete cards, phones and unknown strings', () => {
    expect(guessQuality('ANGLE (NVIDIA, NVIDIA GeForce GT 710 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(guessQuality('ANGLE (NVIDIA, NVIDIA GeForce GT 1030 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    expect(guessQuality('Mali-G78')).toBe('low');
    expect(guessQuality('Adreno (TM) 650')).toBe('low');
    expect(guessQuality('')).toBe('medium');
    expect(guessQuality('Some New GPU 9000')).toBe('medium');
  });

  test('the masked "Apple GPU" of an iPhone or iPad starts at medium; a Mac reporting it keeps high', () => {
    expect(guessQuality('Apple GPU', 'phone')).toBe('medium');
    expect(guessQuality('Apple GPU', 'tablet')).toBe('medium');
    expect(guessQuality('Apple GPU', 'desktop')).toBe('high');
    expect(guessQuality('Apple GPU')).toBe('high');
  });

  test('other phone GPUs and software rendering do not move with the form', () => {
    for (const form of ['phone', 'tablet'] as const) {
      expect(guessQuality('Mali-G78', form)).toBe('low');
      expect(guessQuality('Adreno (TM) 740', form)).toBe('low');
      expect(guessQuality('Google SwiftShader', form)).toBe('low');
    }
  });

  test('a desktop, by default or named, gets the table as it was before the form', () => {
    for (const [gpu, tier] of DESKTOP_TIERS) {
      expect([gpu, guessQuality(gpu)]).toEqual([gpu, tier]);
      expect([gpu, guessQuality(gpu, 'desktop')]).toEqual([gpu, tier]);
    }
  });
});

describe('lowerQuality', () => {
  test('steps one tier down and stops at low', () => {
    expect(lowerQuality('ultra')).toBe('high');
    expect(lowerQuality('high')).toBe('medium');
    expect(lowerQuality('medium')).toBe('low');
    expect(lowerQuality('low')).toBeNull();
  });
});

describe('record', () => {
  test('a record only survives for the GPU it was made for', () => {
    expect(bootQuality({ gpu: 'A', level: 'low' }, 'A')).toBe('low');
    expect(bootQuality({ gpu: 'A', level: 'low' }, 'Apple M2 Pro')).toBe('high');
    expect(bootQuality(null, 'llvmpipe')).toBe('low');
  });

  test('only a GPU whose guess depends on the form ("Apple GPU" on a phone or tablet) files its record under the form', () => {
    for (const gpu of [INTEL_XE, 'Adreno (TM) 740', 'Apple M2 Pro']) {
      for (const form of ['phone', 'tablet'] as const) expect([gpu, form, autoRecordKey(gpu, form)]).toEqual([gpu, form, gpu]);
    }
    expect(autoRecordKey('Apple GPU', 'desktop')).toBe('Apple GPU');
    expect(autoRecordKey('Apple GPU', 'phone')).not.toBe('Apple GPU');
    expect(autoRecordKey('Apple GPU', 'tablet')).not.toBe('Apple GPU');
  });

  test('a 2-in-1 that boots as a desktop one day and a tablet the next keeps the step down it made in either form', () => {
    expect(bootQuality({ gpu: autoRecordKey(INTEL_XE, 'desktop'), level: 'low' }, INTEL_XE, 'tablet')).toBe('low');
    expect(bootQuality({ gpu: autoRecordKey(INTEL_XE, 'tablet'), level: 'low' }, INTEL_XE, 'desktop')).toBe('low');
  });

  test('an iPhone that recorded the old high guess is guessed again once; its own step downs then stay', () => {
    expect(bootQuality({ gpu: 'Apple GPU', level: 'high' }, 'Apple GPU', 'phone')).toBe('medium');
    expect(bootQuality({ gpu: 'Apple GPU · phone', level: 'low' }, 'Apple GPU', 'phone')).toBe('low');
  });

  test('a desktop record does not move', () => {
    expect(bootQuality({ gpu: 'Apple GPU', level: 'medium' }, 'Apple GPU')).toBe('medium');
    expect(bootQuality({ gpu: 'Apple GPU', level: 'medium' }, 'Apple GPU', 'desktop')).toBe('medium');
  });

  test('parseAutoRecord refuses anything that is not a gpu string with a known tier', () => {
    expect(parseAutoRecord({ gpu: 'x', level: 'medium' })).toEqual({ gpu: 'x', level: 'medium' });
    expect(parseAutoRecord({ gpu: 'x', level: 'insane' })).toBeNull();
    expect(parseAutoRecord({ level: 'low' })).toBeNull();
    expect(parseAutoRecord(null)).toBeNull();
    expect(parseAutoRecord('low')).toBeNull();
  });
});

describe('Settings.qualityAuto', () => {
  test('a new player starts with it on; a save from before the option existed keeps its tier', () => {
    expect(defaultSettings().qualityAuto).toBe(true);
    const old = sanitizeSettings({ quality: 'ultra' });
    expect(old.qualityAuto).toBe(false);
    expect(old.quality).toBe('ultra');
  });

  test('it round-trips through the sanitiser either way', () => {
    expect(sanitizeSettings({ ...defaultSettings(), qualityAuto: true }).qualityAuto).toBe(true);
    expect(sanitizeSettings({ ...defaultSettings(), qualityAuto: false }).qualityAuto).toBe(false);
  });
});

describe('canvasMsaaOutlivesStep', () => {
  test('a step down to a tier without canvas MSAA keeps the samples of a context created with them, until a reload', () => {
    expect(canvasMsaaOutlivesStep('low', 4)).toBe(true);
    expect(canvasMsaaOutlivesStep('low', 0)).toBe(false);
  });

  test('tiers that keep canvas MSAA, or that post-process into their own target, have nothing left over', () => {
    for (const level of ['medium', 'high'] as const) expect(canvasMsaaOutlivesStep(level, 4)).toBe(false);
  });
});
