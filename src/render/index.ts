/**
 * Rendering (owner: render agent). three.js r186 WebGLRenderer. All geometry/textures procedural (no external assets).
 * Exported classes/signatures are a CONTRACT used by the App: keep them (you may add members / optional params).
 *
 * Files: GameRenderer.ts (renderer + sizing), RaceScene.ts (track scene, cars, fx, cameras, split-screen),
 * ShowroomScene.ts (menu turntable / podium), car/* (procedural car model + livery atlas), track/* (scenery
 * builders), fx/* (particles, rain), environment.ts (sky / lights / fog), cameras.ts (camera rigs).
 */
export { GameRenderer } from './GameRenderer';
export { RaceScene, type RaceSceneCar, type RaceSceneOptions } from './RaceScene';
export { ShowroomScene } from './ShowroomScene';
export { createCarModel, type CarModel, type CarModelOptions, type CarApplyContext, type CarNodes } from './car/carModel';
export { CarSharedResources } from './car/carMaterials';
export { carDims, type CarDims } from './car/dims';
export { qualityProfile, type QualityProfile } from './core/quality';
export { GRID_LAYOUT } from './track/context';
export { PIT_BOX_COUNT, PIT_BOX_SPACING, PIT_LANE_HALF } from './track/trackFrame';
export { AD_BRANDS } from './track/boards';
