/**
 * Static scenery of one track in build order: feature plan (terrain edits, tunnels, stands), terrain + backdrop, TV spots,
 * road, crossing bridge deck, barriers, pit complex, start gantry, landmarks / tunnels / tree belts, trackside structures,
 * marshal panels, boards and biome props. RaceScene and the headless render tests share it.
 */
import * as THREE from 'three';
import { buildBarriers } from './barriers';
import { buildBoards } from './boards';
import type { SceneryContext } from './context';
import { buildDeck } from './deck';
import { buildForests, buildLandmarks, planLandmarks, type LandmarkPlan } from './landmarks';
import { MarshalPanels } from './marshalPanels';
import { StartGantry, buildPitComplex } from './pitComplex';
import { buildProps } from './props';
import { buildRoad, type RoadParts } from './road';
import { buildTerrain } from './terrain';
import { buildTownscape } from './townscape';
import { buildTrackside, computeTvSpots, type TvSpot } from './trackside';

export interface StaticScenery {
  root: THREE.Group;
  gantry: StartGantry;
  marshals: MarshalPanels;
  road: RoadParts;
  tvSpots: TvSpot[];
  /** terrain height query (the final grid, as rendered) */
  heightAtXZ: (x: number, z: number) => number;
  /** the landmark plan (placements, bridges, dropped features) and how many named stands were built */
  plan: LandmarkPlan;
  featureStandsBuilt: number;
}

export function buildStaticScenery(ctx: SceneryContext, gridSlots: number): StaticScenery {
  const root = new THREE.Group();
  root.name = 'scenery';
  const plan = planLandmarks(ctx);
  const terrain = buildTerrain(ctx);
  root.add(terrain.group);
  const tvSpots = computeTvSpots(ctx, terrain.heightAtXZ);
  const road = buildRoad(ctx, gridSlots);
  root.add(road.group);
  const deck = buildDeck(ctx, terrain.heightAtXZ);
  if (deck) root.add(deck);
  root.add(buildBarriers(ctx, terrain.heightAtXZ));
  const pit = buildPitComplex(ctx);
  ctx.exclusions.push(...pit.exclusions);
  root.add(pit.group);
  const gantry = new StartGantry(ctx);
  root.add(gantry.group);
  const landmarks = buildLandmarks(ctx, plan, terrain.heightAtXZ);
  if (landmarks.children.length > 0) root.add(landmarks);
  const trackside = buildTrackside(ctx, terrain.heightAtXZ, tvSpots);
  root.add(trackside.group);
  const marshals = new MarshalPanels(ctx, terrain.heightAtXZ, trackside.marshalPosts);
  root.add(marshals.group);
  const forests = buildForests(ctx, plan, terrain.heightAtXZ);
  if (forests.children.length > 0) root.add(forests);
  const boards = buildBoards(ctx);
  if (boards) root.add(boards);
  const town = buildTownscape(ctx, terrain.heightAtXZ, terrain.bounds, terrain.seaLevel);
  if (town) root.add(town);
  root.add(buildProps(ctx, terrain.heightAtXZ, terrain.bounds, terrain.seaLevel));
  return { root, gantry, marshals, road, tvSpots, heightAtXZ: terrain.heightAtXZ, plan, featureStandsBuilt: trackside.featureStandsBuilt };
}
