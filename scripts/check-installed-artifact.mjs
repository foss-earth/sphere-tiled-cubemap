import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const owner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf("="); assert.ok(arg.startsWith("--") && at > 2, "Use --name=value"); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = path.resolve(args.out ?? path.join(owner, "build", "installed-consumer", stamp));
assert.ok(output.startsWith(path.join(owner, "build") + path.sep), "Evidence must stay in this owner's build/");
const workspace = path.join(output, "workspace"); mkdirSync(output, { recursive: true }); mkdirSync(workspace);
const dependencies = {}, pins = {};
for (const [key, name, version] of [["tiled", "@foss-earth/sphere-tiled-cubemap", "0.1.0"], ["images", "@foss-earth/images", "0.1.0"], ["cubemap", "@foss-earth/sphere-cubemap", "0.1.0"], ["renderer", "@foss-earth/renderer", "0.1.0"], ["ui", "@foss-earth/ui", "0.1.0"], ["babylon", "@babylonjs/core", "8.56.2"], ["jpeg", "jpeg-js", "0.4.4"], ["typescript", "typescript", "5.9.3"]]) {
  assert.ok(args[key] && /^[a-f0-9]{64}$/.test(args[`${key}-sha256`] ?? ""), `Supply exact --${key} archive and --${key}-sha256`);
  const artifact = path.resolve(args[key]), bytes = readFileSync(artifact), sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, args[`${key}-sha256`]); pins[name] = { artifact, sha256, bytes: bytes.length, version }; dependencies[name] = `file:${artifact}`;
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "tiled-installed-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log, env = {}) => {
  const filename = path.join(output, log), fd = openSync(filename, "wx"); let result;
  try { result = spawnSync(command, argv, { cwd: workspace, env: { ...process.env, ...env, npm_config_cache: path.join(output, "npm-cache") }, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error; assert.equal(result.status, 0, `Inspect ${filename}`); return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(output, "npm-cache")], "install.log");
const physicalWorkspace = realpathSync(workspace) + path.sep;
for (const [name, pin] of Object.entries(pins)) {
  const packageDirectory = realpathSync(path.join(workspace, "node_modules", name));
  const manifestPath = realpathSync(path.join(packageDirectory, "package.json"));
  assert.ok(packageDirectory.startsWith(physicalWorkspace), `${name} physical package escapes isolated workspace`);
  assert.ok(manifestPath.startsWith(packageDirectory + path.sep), `${name} physical manifest escapes its package`);
  const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(installed.name, name); assert.equal(installed.version, pin.version);
}
writeFileSync(path.join(workspace, "guard.mjs"), `
import { registerHooks } from "node:module"; import { realpathSync } from "node:fs"; import { fileURLToPath } from "node:url"; import path from "node:path";
const root = realpathSync(${JSON.stringify(workspace)}) + path.sep;
registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); if (result.url.startsWith("file:")) { const resolved = realpathSync(fileURLToPath(result.url)); if (!resolved.startsWith(root)) throw new Error("OUTSIDE_ISOLATED_WORKSPACE: " + resolved); if (process.env.TILED_PURE === "1" && /[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|@foss-earth[/\\\\]renderer|react(?:-dom)?)(?:[/\\\\]|$)/.test(resolved)) throw new Error("PURE_IMPORTED_RUNTIME_PEER: " + resolved); } return result; } });
`);
writeFileSync(path.join(output, "outside-negative-control.mjs"), "export const neverLoad = true;\n");
writeFileSync(path.join(workspace, "pure.mjs"), `
import assert from "node:assert/strict";
for (const name of ["document", "window", "ImageBitmap", "fetch"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("Pure import read " + name); } });
const root = await import("@foss-earth/sphere-tiled-cubemap"); const core = await import("@foss-earth/sphere-tiled-cubemap/core"); const prep = await import("@foss-earth/sphere-tiled-cubemap/preparation"); const shaders = await import("@foss-earth/sphere-tiled-cubemap/shaders");
assert.equal(root.createCubeTiling, core.createCubeTiling); assert.equal(root.DEFAULT_TILE_CAPACITY_POLICY.viewSlotShare, .75);
const tiling = root.createCubeTiling({ warp: "equi-angular", tileSize: 8, gutter: 1, maxLevel: 1 }); assert.equal(tiling.path(0), "px/0/0/0");
const tile = prep.renderCubeTile({ samplesPerAxis: 1, footprintRadians: 0, source: { sample(_d, _f, out) { out.fill(.5); } } }, "py", 16, "gnomonic", 1, 8, 0, 0); assert.equal(tile.width, 10); assert.equal(tile.data[0], .5);
assert.ok(shaders.TILE_LOOKUP_WGSL.includes("sphereTiles")); assert.ok(shaders.TILE_LOOKUP_GLSL.includes("sphereTiles"));
await assert.rejects(import(${JSON.stringify(path.join(output, "outside-negative-control.mjs"))}), /OUTSIDE_ISOLATED_WORKSPACE/);
console.log("Pure root/core/preparation/shaders with peer/DOM guards and negative control passed");
`);
writeFileSync(path.join(workspace, "public.mjs"), `
import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createTiledSphere } from "@foss-earth/sphere-tiled-cubemap/browser"; import { createSphereTileAtlas } from "@foss-earth/sphere-tiled-cubemap/babylon";
import { TILED_CUBEMAP_PARAMETERS } from "@foss-earth/sphere-tiled-cubemap/settings"; import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createImageSessionBroker } from "@foss-earth/images"; import { tileAtlasLayout } from "@foss-earth/sphere-tiled-cubemap";
import { createImageFileService } from "@foss-earth/images/browser"; import { encodePng } from "@foss-earth/images/node";
import { createImageRegionDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";
assert.equal(typeof createImageRegionDevicePorts, "function"); assert.equal(typeof createTextureTransferTracker, "function");
const settings = createSettingsRegistry(); settings.register(TILED_CUBEMAP_PARAMETERS); assert.equal(settings.get("scene.panorama.tileViewShare"), .75);
const broker = createImageSessionBroker({ requests: 2, decodes: 1, pools: { encoded: 1000, decoded: 1000, sourceGpu: 2000, uploadOutstanding: 1000, overlap: 2000 } }); const scope = broker.scope(), tickets = []; let closed = 0, disposed = 0;
const imageBytes = encodePng({ width: 10, height: 10, rgb: new Uint8Array(10 * 10 * 3).fill(80) });
const record = { id: "tiny", role: "immersion", projection: "tiled-cube", warp: "equi-angular", faceSize: 8, tileSize: 8, gutter: 1, mimeType: "image/png", encodedBytes: imageBytes.length, levelBytes: [imageBytes.length], url: "https://example.invalid/tiles/" }; const layout = tileAtlasLayout(record, 800, 128);
const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }), fetch: async () => new Response(imageBytes, { headers: { "content-type": "image/png" } }), decode: async () => ({ width: 10, height: 10, close() { closed += 1; } }) });
const panorama = createTiledSphere({ representation: record, layout, broker, scope, createAtlas: () => createSphereTileAtlas({ layout, cells: 1, label: "installed", device: { createTexture: () => ({ dispose() { disposed += 1; } }), copyImage(_t, _i, _x, _y, ticket) { tickets.push(ticket); }, copyBytes(_t, _b, ticket) { tickets.push(ticket); } }, reserveUpload(bytes, label) { const result = broker.pools.reserve("uploadOutstanding", bytes, label); return result.ok ? result.reservation : null; } }), obtain: common.obtain, decode: common.decode, limits: { requests: 2, waiting: 2, decodes: 1, uploadsPerFrame: 1, retries: 1, retryDelayMs: 100, fadeMs: 0 }, wake() {} });
const view = { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], tanHalfHeight: .5, tanHalfWidth: .25, heightPx: 8 };
for (let frame = 0; frame < 5; frame++) { panorama.tick(frame, view, { texelsPerPixel: 1, marginDeg: 0, levelCap: 0 }); await new Promise(resolve => setImmediate(resolve)); }
assert.equal(panorama.stats().complete, true); assert.equal(closed, 1); panorama.dispose(); assert.equal(disposed, 2); assert.ok(broker.pools.stats().uploadOutstanding.reserved > 0); for (const ticket of tickets) ticket.release(); broker.dispose(); assert.deepEqual(broker.pools.live(), []);
// Actual installed common native inputs, not a fabricated retain around a
// legacy decoded object. A synchronous copy may cancel its scope or throw.
for (const throwingCopy of [false, true]) {
  const nativeBroker = createImageSessionBroker({ requests: 2, decodes: 1, pools: { encoded: 1000, decoded: 1000, sourceGpu: 2000, uploadOutstanding: 1000, overlap: 2000 } });
  const nativeScope = nativeBroker.scope(), nativeTickets = [], observed = [];
  let nativeClosed = 0, nativeCopies = 0, nativeDisposed = 0;
  const nativeCommon = createImageFileService({ broker: nativeBroker, priority: () => 1, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }),
    fetch: async () => new Response(imageBytes, { headers: { "content-type": "image/png" } }),
    decode: async () => ({ width: 10, height: 10, close() { nativeClosed += 1; } }) });
  const nativeSphere = createTiledSphere({ representation: record, layout, broker: nativeBroker, scope: nativeScope,
    createAtlas: () => createSphereTileAtlas({ layout, cells: 1, label: "installed native cancellation", device: {
      createTexture: () => ({ dispose() { nativeDisposed += 1; } }),
      copyImage(_texture, image, _x, _y, ticket) {
        nativeTickets.push(ticket); nativeCopies += 1;
        assert.deepEqual([image.width, image.height], [10, 10]);
        observed.push(nativeClosed !== 0); assert.equal(nativeBroker.pools.stats().decoded.reserved, 10 * 10 * 4);
        nativeScope.dispose();
        observed.push(nativeClosed !== 0); assert.equal(nativeBroker.pools.stats().decoded.reserved, 10 * 10 * 4);
        if (throwingCopy) throw new Error("Native copy stopped after cancellation.");
      },
      copyBytes(_texture, _bytes, ticket) { nativeTickets.push(ticket); },
    }, reserveUpload(bytes, label) { const result = nativeBroker.pools.reserve("uploadOutstanding", bytes, label); return result.ok ? result.reservation : null; } }),
    obtain: nativeCommon.obtain, decode: nativeCommon.decode,
    limits: { requests: 2, waiting: 2, decodes: 1, uploadsPerFrame: 1, retries: 1, retryDelayMs: 100, fadeMs: 0 }, wake() {} });
  for (let frame = 0; frame < 5; frame++) { nativeSphere.tick(frame, view, { texelsPerPixel: 1, marginDeg: 0, levelCap: 0 }); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(observed, [false, false]); assert.equal(nativeCopies, 1); assert.equal(nativeClosed, 1);
  assert.equal(nativeBroker.pools.stats().decoded.reserved, 0); assert.equal(nativeDisposed, 2);
  nativeSphere.dispose(); nativeSphere.dispose(); assert.equal(nativeClosed, 1); assert.equal(nativeDisposed, 2);
  assert.ok(nativeBroker.pools.stats().uploadOutstanding.reserved > 0);
  for (const ticket of nativeTickets) { ticket.release(); ticket.release(); }
  nativeBroker.dispose(); assert.deepEqual(nativeBroker.pools.live(), []);
}
console.log("Actual common decoded inputs survive synchronous native cancellation and throwing copies; submitted grants remain renderer-owned.");
const owner = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@foss-earth/sphere-tiled-cubemap")))); const manifest = JSON.parse(readFileSync(path.join(owner, "package.json"), "utf8")); for (const value of Object.values(manifest.exports)) if (typeof value === "object") assert.ok(readFileSync(path.join(owner, value.types)).length); assert.equal(JSON.parse(readFileSync(path.join(owner, manifest.exports["./schema.json"]), "utf8")).type, "object"); console.log("Installed public adapters/settings/schema and common lifetime mock passed");
`);
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "pure.mjs")], "pure-runtime.log", { TILED_PURE: "1" });
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "public.mjs")], "public-runtime.log");
// The common broker declarations expose standard AbortSignal; DOM typings
// supply it without permitting runtime DOM/renderer initialization.
for (const [name, lib] of [["pure", ["ES2023", "DOM"]], ["public", ["ES2023", "DOM", "DOM.Iterable"]]]) {
  writeFileSync(path.join(workspace, `${name}.ts`), readFileSync(path.join(owner, "fixtures", `${name}-consumer.ts`)));
  const config = path.join(workspace, `tsconfig.${name}.json`); writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib, types: [], strict: true, skipLibCheck: false, noEmit: true, incremental: true, tsBuildInfoFile: `node_modules/.tmp/${name}.tsbuildinfo` }, include: [`${name}.ts`] }));
  const trace = run(process.execPath, [path.join(workspace, "node_modules", "typescript", "bin", "tsc"), "-p", config, "--traceResolution"], `${name}-types.log`);
  for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) assert.ok(realpathSync(match[1]).startsWith(physicalWorkspace), "Declaration resolution escaped isolated workspace");
}
const receipt = { pins, runtime: { node: process.version, platform: process.platform, arch: process.arch }, entries: [".", "./core", "./preparation", "./shaders", "./browser", "./babylon", "./settings", "./schema.json"], checks: ["exact offline archives", "installed physical package names/versions/realpaths", "realpath guard and negative control", "no DOM/runtime initialization in pure entries", "actual common retained decoded inputs and renderer submitted-grant lifetime", "synchronous copy cancellation and throwing-copy native input holds", "full strict pure and optional declarations", "schema bytes"], limitations: ["no actual GPU/backend qualification", "local candidate only", "common attribution conformance/remote admission separate"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify({ output, receipt }));
