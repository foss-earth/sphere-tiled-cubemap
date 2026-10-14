/** Tiled layout/residency belongs here; the supplied renderer owns texture allocation/copies. */
import { Constants, type BaseTexture } from "@babylonjs/core";
import type { ImageRegionDevicePorts, UploadTicket } from "@foss-earth/renderer/babylon";
import type { TileAtlasLayout } from "../layout.js";

export interface SphereTileAtlas {
  readonly layout: TileAtlasLayout;
  readonly atlas: BaseTexture;
  readonly table: BaseTexture;
  uploadTile(slot: number, image: ImageBitmap): boolean;
  setTable(bytes: Uint8Array): boolean;
  /** Reserve the display-table copy before overwriting any currently visible slot. */
  beginUpdate(): boolean;
  endUpdate(): void;
  dispose(): void;
}

export function createSphereTileAtlas(options: {
  device: ImageRegionDevicePorts; layout: TileAtlasLayout; cells: number; label: string;
  reserveUpload(bytes: number, label: string): UploadTicket | null;
}): SphereTileAtlas {
  const { device, layout, cells, label } = options;
  if (![layout.width, layout.height, layout.stored, layout.slots, layout.perRow, cells].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Atlas layout dimensions must be positive integers.");
  const tableSize = 6 * cells * 2 * cells * 4;
  if (!Number.isSafeInteger(tableSize) || layout.width !== layout.perRow * layout.stored || layout.height % layout.stored !== 0 || layout.slots > layout.perRow * (layout.height / layout.stored) || layout.perRow > 255 || layout.height / layout.stored > 255 || layout.gpuBytes !== 4 * layout.width * layout.height + tableSize) throw new Error("Atlas slot/table geometry or GPU byte cost is inconsistent.");
  let atlas: BaseTexture | null = null;
  let table: BaseTexture | null = null;
  try {
    atlas = device.createTexture({ width: layout.width, height: layout.height, label, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE, srgb: true });
    table = device.createTexture({ width: 6 * cells, height: 2 * cells, label: `${label} table`, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE, srgb: false });
    for (const texture of [atlas, table]) {
      texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
      texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
      // No derivative spanning adjacent slots may collect another tile's texels.
      texture.anisotropicFilteringLevel = 1;
    }
  } catch (error) { try { table?.dispose(); } finally { atlas?.dispose(); } throw error; }
  let tableTicket: UploadTicket | null = null;
  let disposed = false;
  return {
    layout, atlas, table,
    beginUpdate() {
      if (disposed) return false;
      if (!tableTicket) {
        const ticket = options.reserveUpload(tableSize, `${label} table`);
        if (disposed) { ticket?.release(); return false; }
        tableTicket = ticket;
      }
      return tableTicket !== null;
    },
    endUpdate() { const ticket = tableTicket; tableTicket = null; ticket?.release(); },
    uploadTile(slot, image) {
      if (disposed || !tableTicket) return false;
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= layout.slots) throw new Error(`Tile slot ${slot} is outside the atlas's ${layout.slots}.`);
      if (image.width !== layout.stored || image.height !== layout.stored) throw new Error(`A tile is ${image.width} × ${image.height}; this atlas holds ${layout.stored} × ${layout.stored}.`);
      const ticket = options.reserveUpload(layout.stored * layout.stored * 4, `${label} tile`);
      if (!ticket) return false;
      if (disposed) { ticket.release(); return false; }
      // Renderer takes the grant even on a partial or throwing submission.
      device.copyImage(atlas, image, slot % layout.perRow * layout.stored, Math.floor(slot / layout.perRow) * layout.stored, ticket);
      return true;
    },
    setTable(bytes) {
      if (disposed) return false;
      if (bytes.length !== tableSize) throw new Error("Display table dimensions do not match the atlas.");
      const ticket = tableTicket ?? options.reserveUpload(bytes.byteLength, `${label} table`);
      if (!ticket) return false;
      if (disposed) { ticket.release(); return false; }
      tableTicket = null;
      device.copyBytes(table, bytes, ticket);
      return true;
    },
    dispose() {
      if (disposed) return; disposed = true;
      const ticket = tableTicket; tableTicket = null;
      try { ticket?.release(); } finally { try { atlas.dispose(); } finally { table.dispose(); } }
      // Submitted grants belong to the host renderer tracker until completion/loss.
    },
  };
}
