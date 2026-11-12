/**
 * Automatic quality: the first pick from the WebGL renderer string, the one-way step down, and which recorded pick
 * survives a restart (same GPU) or is dropped (another GPU).
 */
import { describe, expect, test } from 'bun:test';
import { defaultSettings, sanitizeSettings } from '../src/meta/save';
import { bootQuality, canvasMsaaOutlivesStep, guessQuality, isSoftwareGpu, lowerQuality, parseAutoRecord } from '../src/render/core/autoQuality';

const ANGLE = (vendor: string, name: string): string => `ANGLE (${vendor}, ${name}, Unspecified Version)`;

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
