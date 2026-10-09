import { createCubeTiling, createTileScheduler, createTiledCubeRepresentation, tiledCubeFilesWithLevel, type TileView } from "@foss-earth/tiled-cubemap";
import { renderCubeTile } from "@foss-earth/tiled-cubemap/preparation";
import { TILE_LOOKUP_GLSL, TILE_LOOKUP_WGSL } from "@foss-earth/tiled-cubemap/shaders";
export const view: TileView = { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], tanHalfHeight: 0.5, tanHalfWidth: 0.25, heightPx: 8 };
void [createCubeTiling, createTileScheduler, createTiledCubeRepresentation, tiledCubeFilesWithLevel, renderCubeTile, TILE_LOOKUP_GLSL, TILE_LOOKUP_WGSL];
