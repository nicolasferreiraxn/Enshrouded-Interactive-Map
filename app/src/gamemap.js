// Camada do Leaflet que desenha o mapa com o MESMO shader do jogo (MapRenderer_rgba, fs_main),
// decompilado de game38_ui/map_renderer.gpc (ver shader/map_fs.glsl). Mesmas texturas,
// mesmas isolinhas (marching squares em espaço de tela) e mesma névoa das zonas de Mortalha.
import L from 'leaflet';

const N = 10; // tileCount do UiMapResource
const WORLD = 10240;

const VS = `#version 300 es
in vec2 p;
out vec2 vScreen;
void main() { vScreen = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// Tradução direta do fs decompilado. Nomes dos campos de UiMapShaderData pela reflexão do jogo.
const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vScreen;
out vec4 outColor;
uniform sampler2D baseHeight;       // R32F 1280x1280 (R16 unorm do jogo)
uniform sampler2DArray detail;      // 100 x R8 1024x1024 (BC4 do jogo)
uniform sampler2DArray fogZone;     // 100 x RG8 (BC5 do jogo)
uniform sampler2D baseGradient, isolineGradient, fogBorder, fogNoise, fogNormal, fogDangerous;
uniform vec2 uvOrigin;   // uv do canto superior esquerdo da tela
uniform vec2 uvPerPixel; // uv por pixel de tela
uniform vec2 viewport;
uniform vec3 isoWidth;   // isolineWidths (em px)
uniform vec3 isoAlpha;   // isolineAlphas
uniform float isolineSpacing, playerFogLevel, fogNoiseOffset, fogDisplacementStrength, fogZoneAlpha;

const ivec2 OFS[5] = ivec2[](ivec2(0, -1), ivec2(-1, 0), ivec2(0), ivec2(1, 0), ivec2(0, 1));
const vec2 CRN[4] = vec2[](vec2(-0.5), vec2(0.5, -0.5), vec2(0.5), vec2(-0.5, 0.5));

int tileLayer(vec2 uv) {
  ivec2 t = ivec2(clamp(floor(uv * float(${N})), 0.0, float(${N - 1})));
  return (${N - 1} - t.y) * ${N} + t.x; // linha (ny-1-y), como no jogo
}
float baseAt(vec2 uv) {
  // bilinear manual (R32F pode não ter filtragem linear)
  vec2 s = uv * 1280.0 - 0.5; vec2 i = floor(s); vec2 f = s - i;
  float a = texelFetch(baseHeight, ivec2(clamp(i, vec2(0), vec2(1279))), 0).r;
  float b = texelFetch(baseHeight, ivec2(clamp(i + vec2(1, 0), vec2(0), vec2(1279))), 0).r;
  float c = texelFetch(baseHeight, ivec2(clamp(i + vec2(0, 1), vec2(0), vec2(1279))), 0).r;
  float d = texelFetch(baseHeight, ivec2(clamp(i + vec2(1, 1), vec2(0), vec2(1279))), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// altura num ponto: base * 4096 + (detalhe - 0,5) * 255 (fs_main, _382)
float heightAt(vec2 uv, vec2 tileOfs, int layer, vec2 local) {
  vec2 tileStep = vec2(1.0 / float(${N}));
  float h = baseAt(uv + (tileOfs + vec2(0.00390625)) * tileStep) * 4096.0;
  h += (texture(detail, vec3(local + tileOfs, float(layer))).r - 0.5) * 255.0;
  return h;
}

void main() {
  vec2 screen = vec2(vScreen.x, 1.0 - vScreen.y) * viewport;
  vec2 uv = uvOrigin + screen * uvPerPixel;
  if (any(lessThan(uv, vec2(0))) || any(greaterThan(uv, vec2(1)))) { outColor = vec4(0.106, 0.102, 0.098, 1); return; }
  vec2 tiles = uv * float(${N});
  vec2 local = fract(tiles);
  int layer = tileLayer(uv);
  float texel = 1.0 / 1024.0;
  float h0 = heightAt(uv, vec2(0), layer, local);
  float t = min(h0, 1024.0) / 1024.0;
  // _390: texels do detalhe por pixel de tela (≤ 1)
  float px = clamp(uvPerPixel.x * float(${N}) * 1024.0, 0.0, 1.0);

  vec3 dist = vec3(2.0);
  for (int k = 0; k < 5; k++) {
    vec2 o = vec2(OFS[k]);
    vec4 hh;
    hh.x = heightAt(uv, ((o * px) + vec2(0.5)) * texel, layer, local);
    hh.y = heightAt(uv, (((o + vec2(1, 0)) * px) + vec2(0.5)) * texel, layer, local);
    hh.z = heightAt(uv, (((o + vec2(1)) * px) + vec2(0.5)) * texel, layer, local);
    hh.w = heightAt(uv, (((o + vec2(0, 1)) * px) + vec2(0.5)) * texel, layer, local);
    vec4 f = hh / isolineSpacing;
    int lo = int(min(min(f.x, f.y), min(f.z, f.w)));
    int hi = int(max(max(f.x, f.y), max(f.z, f.w)));
    vec2 me = -o - vec2(0.5);
    for (int lvl = lo; lvl <= hi; lvl++) {
      vec4 dd = f - float(lvl);
      bvec4 pos = greaterThanEqual(dd, vec4(0));
      bool cr[4];
      int nc = 0;
      for (int i = 0; i < 4; i++) { cr[i] = pos[i] != pos[(i + 1) % 4]; if (cr[i]) nc++; }
      if (nc != 2) continue;
      vec2 a = vec2(0), b = vec2(0); bool got = false;
      for (int i = 0; i < 4 && !got; i++) {
        int j = (i + 1) % 4, m = (i + 2) % 4;
        if (cr[i] && cr[j]) {
          a = mix(CRN[i], CRN[j], (0.0 - dd[i]) / (dd[j] - dd[i]));
          b = mix(CRN[j], CRN[m], (0.0 - dd[j]) / (dd[m] - dd[j]));
          got = true;
        }
      }
      for (int i = 0; i < 2 && !got; i++) {
        int j = (i + 1) % 4, m = (i + 2) % 4, n = (i + 3) % 4;
        if (cr[i] && cr[m]) {
          a = mix(CRN[i], CRN[j], (0.0 - dd[i]) / (dd[j] - dd[i]));
          b = mix(CRN[m], CRN[n], (0.0 - dd[m]) / (dd[n] - dd[m]));
          got = true;
        }
      }
      if (!got) continue;
      vec2 ab = b - a; float l2 = dot(ab, ab);
      float d = l2 < 1e-4 ? length(me - a) : length(a + ab * clamp(dot(me - a, ab) / l2, 0.0, 1.0) - me);
      if ((lvl & 1) != 0) dist.x = min(dist.x, d);
      else if ((lvl & 2) != 0) dist.y = min(dist.y, d);
      else dist.z = min(dist.z, d);
    }
  }
  float l0 = (1.0 - smoothstep(isoWidth.x - px, isoWidth.x + px, dist.x)) * isoAlpha.x;
  float l1 = (1.0 - smoothstep(isoWidth.y - px, isoWidth.y + px, dist.y)) * isoAlpha.y;
  float l2v = (1.0 - smoothstep(isoWidth.z - px, isoWidth.z + px, dist.z)) * isoAlpha.z;
  float line = max(max(max(l0, 0.0), l1), l2v);
  vec4 ig = texture(isolineGradient, vec2(t, 0.5));
  vec3 col = mix(texture(baseGradient, vec2(t, 0.5)).rgb, ig.rgb, ig.a * line);

  // zonas de Mortalha (fogZone .x = distância da borda, .y*255 = nível da zona)
  vec2 nuv = uv * 4.0;
  float n1 = texture(fogNoise, nuv + vec2(fogNoiseOffset, 0)).r;
  float n2 = texture(fogNoise, nuv + vec2(0, -fogNoiseOffset * 1.1)).r;
  vec2 e1 = smoothstep(vec2(0), vec2(0.5), uv), e2 = smoothstep(vec2(0), vec2(0.5), vec2(1) - uv);
  float edge = e1.x * e1.y * e2.x * e2.y;
  vec2 disp = vec2((n1 * 2.0 - 0.5) * fogDisplacementStrength * edge * 0.25, (n2 * 2.0 - 0.5) * fogDisplacementStrength * edge * 0.25);
  vec4 fz = texture(fogZone, vec3(local + disp * texel, float(layer)));
  if (fz.r > 0.0 || fz.g > 0.0) {
    vec3 c1, c2;
    if (fz.g * 255.0 > playerFogLevel) {
      c1 = texture(fogDangerous, nuv + vec2(0.1, 0.15) + vec2(-fogNoiseOffset * 0.2, fogNoiseOffset)).rgb;
      c2 = texture(fogDangerous, nuv + vec2(-fogNoiseOffset, fogNoiseOffset * 0.8)).rgb;
    } else {
      c1 = texture(fogNormal, nuv + vec2(0.1, 0.15) + vec2(-fogNoiseOffset * 0.2, fogNoiseOffset)).rgb;
      c2 = texture(fogNormal, nuv + vec2(-fogNoiseOffset, fogNoiseOffset * 0.7)).rgb;
    }
    float a = texture(fogBorder, vec2(fz.r, 0.5)).r * fogZoneAlpha;
    col = mix(col, c1 + c2, a);
  }
  outColor = vec4(col, 1.0);
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

async function bitmap(url) {
  const b = await (await fetch(url)).blob();
  return createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function tex2D(gl, unit, img, { repeat = false, linear = true } = {}) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  return t;
}

export const GameMapLayer = L.Layer.extend({
  options: { isolineSpacing: 8, playerFogLevel: 5 },
  onAdd(map) {
    this._map = map;
    const c = (this._canvas = L.DomUtil.create('canvas', 'gamemap'));
    map.getPane('tilePane').appendChild(c);
    const gl = (this._gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false }));
    if (!gl) { console.error('WebGL2 indisponível'); return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this._prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this._u = (n) => gl.getUniformLocation(prog, n);
    this._ready = false;
    this._load().then(() => { this._ready = true; this._redraw(); });
    map.on('move zoom viewreset resize', this._redraw, this);
    this._anim = () => { this._t = performance.now(); this._redraw(); this._raf = requestAnimationFrame(this._anim); };
    this._raf = requestAnimationFrame(this._anim);
  },
  onRemove(map) {
    cancelAnimationFrame(this._raf);
    map.off('move zoom viewreset resize', this._redraw, this);
    this._canvas.remove();
  },
  setOptions(o) { L.setOptions(this, o); this._redraw(); },
  async _load() {
    const gl = this._gl;
    // 0: altura base (R16 -> float)
    const raw = new Uint16Array(await (await fetch('./gpu/baseHeight.bin')).arrayBuffer());
    const f = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) f[i] = raw[i] / 65535;
    gl.activeTexture(gl.TEXTURE0);
    const tb = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1280, 1280, 0, gl.RED, gl.FLOAT, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // 1, 2: arrays de 100 tiles (detalhe R8, zona de Mortalha RG8)
    const arr = async (unit, dir, internal, fmt, keep) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, 1024, 1024, N * N);
      const cv = new OffscreenCanvas(1024, 1024); const cx = cv.getContext('2d', { willReadFrequently: true });
      const jobs = [];
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) jobs.push([x, y]);
      await Promise.all(jobs.map(async ([x, y]) => {
        const img = await bitmap(`./gpu/${dir}/${x}_${y}.png`);
        cx.clearRect(0, 0, 1024, 1024); cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, 1024, 1024).data;
        const out = new Uint8Array(1024 * 1024 * keep);
        for (let i = 0, j = 0; i < px.length; i += 4) { out[j++] = px[i]; if (keep === 2) out[j++] = px[i + 1]; }
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, y * N + x, 1024, 1024, 1, fmt, gl.UNSIGNED_BYTE, out);
      }));
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    await arr(1, 'detail', gl.R8, gl.RED, 1);
    await arr(2, 'fog', gl.RG8, gl.RG, 2);
    const one = async (unit, name, opt) => tex2D(this._gl, unit, await bitmap(`./gpu/${name}.png`), opt);
    await one(3, 'baseGradient'); await one(4, 'isolineGradient'); await one(5, 'fogZoneBorderGradient');
    await one(6, 'fogNoise', { repeat: true }); await one(7, 'fogZoneNormal', { repeat: true }); await one(8, 'fogZoneDangerous', { repeat: true });
    const u = this._u; gl.useProgram(this._prog);
    ['baseHeight', 'detail', 'fogZone', 'baseGradient', 'isolineGradient', 'fogBorder', 'fogNoise', 'fogNormal', 'fogDangerous'].forEach((n, i) => gl.uniform1i(u(n), i));
  },
  _redraw() {
    if (!this._ready || !this._map) return;
    const map = this._map, c = this._canvas, gl = this._gl;
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (c.width !== size.x * dpr || c.height !== size.y * dpr) { c.width = size.x * dpr; c.height = size.y * dpr; c.style.width = size.x + 'px'; c.style.height = size.y + 'px'; }
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    // pixel de tela -> metros do mundo (zoom nativo 5 = 1 px por metro) -> uv do mapa
    const tl = map.project(map.containerPointToLatLng([0, 0]), 5);
    const scale = map.getZoomScale(5, map.getZoom()) / dpr; // metros por pixel do canvas
    gl.viewport(0, 0, c.width, c.height);
    const u = this._u;
    gl.uniform2f(u('uvOrigin'), tl.x / WORLD, tl.y / WORLD);
    gl.uniform2f(u('uvPerPixel'), scale / WORLD, scale / WORLD);
    gl.uniform2f(u('viewport'), c.width, c.height);
    // FbUiMap.zoomConfigs: espessura*3 px e alfa por classe de isolinha (0,7..4 e 8..16)
    const zs = 1 / scale;
    const cfg = zs >= 6 ? [[0.3, 0.3, 0.3], [0.3, 0.5, 0.9]] : [[0.2, 0.5, 0.5], [0.2, 0.5, 1.0]];
    gl.uniform3f(u('isoWidth'), cfg[0][0] * 3 * dpr, cfg[0][1] * 3 * dpr, cfg[0][2] * 3 * dpr);
    gl.uniform3f(u('isoAlpha'), ...cfg[1]);
    gl.uniform1f(u('isolineSpacing'), this.options.isolineSpacing);
    gl.uniform1f(u('playerFogLevel'), this.options.playerFogLevel);
    const tt = (this._t || 0) / 1000;
    gl.uniform1f(u('fogNoiseOffset'), (tt * 0.01) % 1);
    gl.uniform1f(u('fogDisplacementStrength'), 1.0);
    // fogZoneAlphaRange 0,2..0,3 pulsando a cada 3 s (FbUiMap.fogZonePulseLength)
    gl.uniform1f(u('fogZoneAlpha'), 0.25 + 0.05 * Math.sin((tt / 3) * Math.PI * 2));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  },
});
