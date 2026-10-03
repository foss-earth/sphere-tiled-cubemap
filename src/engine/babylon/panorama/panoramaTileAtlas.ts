/**
 * A tiled panorama's GPU side (src/scenes/tiles/): one atlas of tile slots,
 * allocated once and filled a tile at a time, and the display table, a small
 * texture saying which slot each cell shows.
 *
 * Every tap is bilinear with no anisotropy, so a pixel whose neighbours read
 * another slot does not gather texels from it.
 *
 * The atlas follows the panorama textures' colour contract
 * (panoramaTextures.ts): on WebGPU it is rgba8unorm-srgb, so samples arrive in
 * linear light; on WebGL it holds encoded sRGB, which the shader decodes where
 * it blends. It has no mips: selection chooses each cell's level instead, and
 * every tap stays inside one tile's stored texels, so no tap reads a
 * neighbouring slot. A tile arriving costs one sub-image copy from its decoded
 * bitmap, with nothing read back to JavaScript; the table, a few kilobytes,
 * is uploaded whole when it changes. Babylon does not rebuild these after a
 * device loss; their owner does.
 */
import { BaseTexture, Constants, InternalTexture, InternalTextureSource, RawTexture, type Engine, type Scene, type WebGPUEngine } from "@babylonjs/core";
import type { TileAtlasLayout } from "../../../scenes/budget";
import { isWebGpuEngine } from "./panoramaTextures";

export interface PanoramaTileAtlas {
  readonly layout: TileAtlasLayout;
  readonly atlas: BaseTexture;
  readonly table: BaseTexture;
  /** Copies a decoded tile, exactly `layout.stored` texels a side, into a slot. */
  uploadTile(slot: number, image: ImageBitmap): void;
  /** The whole display table: `6 · cells` by `2 · cells` RGBA bytes. */
  setTable(bytes: Uint8Array): void;
  dispose(): void;
}

interface WebGpuInternals {
  _device: GPUDevice;
  _textureHelper: { createGPUTextureForInternalTexture(texture: InternalTexture, width?: number, height?: number, depth?: number, flags?: number): unknown };
}

export function createPanoramaTileAtlas(scene: Scene, layout: TileAtlasLayout, cells: number, label: string): PanoramaTileAtlas {
  const engine = scene.getEngine();
  const webGpu = isWebGpuEngine(engine);
  let atlas: BaseTexture;
  let upload: (slot: number, image: ImageBitmap) => void;
  const origin = (slot: number) => ({ x: (slot % layout.perRow) * layout.stored, y: Math.floor(slot / layout.perRow) * layout.stored });
  const checkSlot = (slot: number, image: ImageBitmap): void => {
    if (!(slot >= 0 && slot < layout.slots)) throw new Error(`Tile slot ${slot} is outside the atlas's ${layout.slots}.`);
    if (image.width !== layout.stored || image.height !== layout.stored) throw new Error(`A tile is ${image.width} × ${image.height}; this atlas holds ${layout.stored} × ${layout.stored}.`);
  };

  if (webGpu) {
    const gpu = engine as unknown as WebGPUEngine & WebGpuInternals;
    const internal = new InternalTexture(gpu, InternalTextureSource.Unknown);
    internal.format = Constants.TEXTUREFORMAT_RGBA;
    internal.type = Constants.TEXTURETYPE_UNSIGNED_BYTE;
    internal._useSRGBBuffer = true;
    internal.generateMipMaps = false;
    internal.samplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
    internal.label = label;
    internal.invertY = false;
    gpu._textureHelper.createGPUTextureForInternalTexture(internal, layout.width, layout.height, 1, 0);
    internal.isReady = true;
    const target = (internal._hardwareTexture as unknown as { underlyingResource: GPUTexture }).underlyingResource;
    atlas = new BaseTexture(scene, internal);
    atlas.gammaSpace = false;
    upload = (slot, image) => {
      checkSlot(slot, image);
      gpu._device.queue.copyExternalImageToTexture(
        { source: image, flipY: false },
        { texture: target, mipLevel: 0, origin: { ...origin(slot), z: 0 }, colorSpace: "srgb", premultipliedAlpha: false },
        { width: layout.stored, height: layout.stored, depthOrArrayLayers: 1 },
      );
    };
  } else {
    const gl = (engine as Engine)._gl;
    const internal = (engine as Engine).createRawTexture(null, layout.width, layout.height, Constants.TEXTUREFORMAT_RGBA, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    internal.label = label;
    internal.isReady = true;
    atlas = new BaseTexture(scene, internal);
    atlas.gammaSpace = true;
    upload = (slot, image) => {
      checkSlot(slot, image);
      const at = origin(slot);
      const glEngine = engine as Engine;
      // Read the caller's pixel-store state, as the panorama uploader does, and put it back.
      const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
      const conversion = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
      glEngine._bindTextureDirectly(gl.TEXTURE_2D, internal, true);
      glEngine._unpackFlipY(false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      try {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, gl.RGBA, gl.UNSIGNED_BYTE, image);
      } finally {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, conversion);
        glEngine._bindTextureDirectly(gl.TEXTURE_2D, null, true);
      }
    };
  }
  atlas.name = label;
  atlas.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  atlas.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  // Babylon's default of 4 spreads a WebGL tap along its derivative; where neighbouring pixels read two
  // different slots that derivative spans the atlas, and the tap would gather other tiles at the seam.
  atlas.anisotropicFilteringLevel = 1;

  const tableBytes = new Uint8Array(6 * cells * 2 * cells * 4);
  const table = new RawTexture(tableBytes, 6 * cells, 2 * cells, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  table.name = `${label} table`;
  table.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  table.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  table.anisotropicFilteringLevel = 1;

  let disposed = false;
  return {
    layout,
    atlas,
    table,
    uploadTile(slot, image) {
      if (!disposed) upload(slot, image);
    },
    setTable(bytes) {
      if (!disposed) table.update(bytes);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      atlas.dispose();
      table.dispose();
    },
  };
}
