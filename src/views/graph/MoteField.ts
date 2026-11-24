import * as THREE from "three";
import Link from "../../graph/Link";
import Node from "../../graph/Node";
import { RENDER_LAYER } from "./GraphBatches";

// Motes of light flowing along links, like iron filings tracing the field
// between two magnetic poles. Each link gets a few field lines: arcs from the
// source to the target, each bowed out by its own amount in its own direction
// around the link, together forming a spindle. Motes travel each line in an
// evenly spaced train, so the lines read as dotted arcs of light.
//
// The motes move on the GPU. Each mote's shape (its line's direction and
// bow, its place in the train, its size) is fixed when the links are laid
// out. Each frame only the links change: their ends, colors and brightness
// go into a small float texture (LINK_TEXELS texels per link), and the
// vertex shader places every mote on its link's arc.

type Positioned = Node & { x?: number; y?: number; z?: number };
type Endpoint = string | Positioned;

export interface MoteStyle {
	// motes per link (0 hides the link's motes)
	count: (link: Link) => number;
	// color at the source and target end (any CSS color)
	colors: (link: Link) => [string, string];
	// brightness multiplier, 0..1
	brightness: (link: Link) => number;
	size: number; // world units
	speed: number; // fraction of the link per second
	spread: number; // max bow, as a fraction of the link length
	solidity: number; // 0 = soft glow, 1 = solid dot
	// two-way links: 0 = both streams share the spindle, 1 = each stream
	// keeps to its own side of the link
	coalescence: number;
	additive: boolean; // glow on dark backgrounds; normal blending on light
}

// Stable 32-bit hash of a string (FNV-1a with a murmur3 finalizer)
const hashString = (text: string): number => {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return fmix(h);
};
// murmur3's fmix32: near-identical inputs give unrelated outputs
const fmix = (h: number): number => {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
};
// Stable pseudo-random number in [0, 1) for a link, an index and a salt
const rand = (key: number, index: number, salt: number): number =>
	fmix(key ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt, 0x27d4eb2f)) / 4294967296;
// salts, so each random property of a line or mote is independent
const enum Salt {
	Turn = 1,
	Angle,
	Bow,
	Speed,
	Offset,
	Jitter,
	Size,
	Twinkle,
}

const endId = (end: Endpoint) => (typeof end === "string" ? end : end.id);

// texels per link in the link texture: source end, target end, source
// color + brightness, target color
const LINK_TEXELS = 4;
const TEXTURE_WIDTH = 4096;

const VERTEX = `
uniform sampler2D uLinks;
uniform float uTime;
uniform float uSpeed;
uniform float uSpread;
uniform float uSize;
uniform float uScale;
uniform float uFlicker;
// position: (link index + 1, negative for a reversed mote; phase; speed)
attribute vec4 aShape; // cos and sin of the line's angle, bow, least bow
attribute vec2 aLook; // size, twinkle phase
varying float vAlpha;
varying vec3 vColor;

vec4 linkTexel(int i) {
	return texelFetch(uLinks, ivec2(i % ${TEXTURE_WIDTH}, i / ${TEXTURE_WIDTH}), 0);
}

void main() {
	int link = int(abs(position.x)) - 1;
	vec4 from = linkTexel(link * ${LINK_TEXELS} + 2);
	float bright = from.a;
	if (bright <= 0.0) {
		// hidden: off screen, nothing to rasterize
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		vAlpha = 0.0;
		vColor = vec3(0.0);
		return;
	}
	vec3 a = linkTexel(link * ${LINK_TEXELS}).xyz;
	vec3 b = linkTexel(link * ${LINK_TEXELS} + 1).xyz;
	vec3 to = linkTexel(link * ${LINK_TEXELS} + 3).rgb;

	// position along the arc, source (0) to target (1); color follows it,
	// so a reversed mote starts in the target's color
	float progress = fract(position.y + uTime * uSpeed * position.z);
	float t = position.x < 0.0 ? 1.0 - progress : progress;

	vec3 d = b - a;
	float len = max(length(d), 1e-6);
	vec3 u = d / len;
	// two unit vectors perpendicular to the link
	vec3 v = normalize(cross(u, abs(u.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
	vec3 w = cross(u, v);
	// control point: the midpoint pushed out around the link
	float bow = max(aShape.z * uSpread, aShape.w) * len;
	vec3 c = (a + b) * 0.5 + (v * aShape.x + w * aShape.y) * bow;
	vec3 p = (1.0 - t) * (1.0 - t) * a + 2.0 * (1.0 - t) * t * c + t * t * b;

	vColor = mix(from.rgb, to, t);
	// fade in at the source, out at the target; solid dots hold steady,
	// soft motes twinkle
	float twinkle = 1.0 - uFlicker * (1.0 - sin(uTime * 3.0 + aLook.y));
	vAlpha = sin(3.14159265 * t) * twinkle * bright;

	vec4 mv = modelViewMatrix * vec4(p, 1.0);
	gl_PointSize = uSize * aLook.x * uScale / -mv.z;
	gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = `
uniform float uSolid;
varying float vAlpha;
varying vec3 vColor;
void main() {
	if (vAlpha <= 0.0) discard;
	float d = length(gl_PointCoord - vec2(0.5));
	if (d > 0.5) discard;
	// soft: a bright core inside a glow, the core a little whiter, like a
	// point of light
	float glow = pow(1.0 - d * 2.0, 2.0) * 0.55;
	float core = smoothstep(0.16, 0.0, d);
	float soft = min(1.0, glow + core);
	// solid: an opaque dot with a crisp edge, about the glow's visible size
	float solid = 1.0 - smoothstep(0.24, 0.3, d);
	vec3 color = mix(vColor, vec3(1.0), core * 0.35 * (1.0 - uSolid));
	gl_FragColor = vec4(color, vAlpha * mix(soft, solid, uSolid));
}`;

export class MoteField {
	private readonly scene: THREE.Object3D;
	private points: THREE.Points | null = null;
	private geometry: THREE.BufferGeometry | null = null;
	private material: THREE.ShaderMaterial | null = null;
	private texture: THREE.DataTexture | null = null;
	private textureData = new Float32Array(0);
	private links: Link[] = [];
	private moteCount = 0;
	private time = 0;
	private readonly colorCache = new Map<string, THREE.Color>();

	constructor(scene: THREE.Object3D) {
		this.scene = scene;
	}

	get count() {
		return this.moteCount;
	}

	// Lays out motes for the given links (call when links or counts change)
	public setLinks(links: Link[], style: MoteStyle) {
		this.links = links;
		const counts = links.map((link) => Math.max(0, Math.round(style.count(link))));
		const total = counts.reduce((a, b) => a + b, 0);
		this.moteCount = total;

		// mote attributes; see VERTEX
		const position = new Float32Array(total * 3);
		const shape = new Float32Array(total * 4);
		const look = new Float32Array(total * 2);
		const golden = Math.PI * (3 - Math.sqrt(5));
		const sep = Math.min(1, Math.max(0, style.coalescence));
		let m = 0;
		links.forEach((link, index) => {
			const n = counts[index];
			if (n === 0) return;
			const key = hashString(`${endId(link.source as Endpoint)}|${endId(link.target as Endpoint)}`);
			// a few field lines per link; motes are shared out between them.
			// Notes that link to each other get lines flowing both ways, so a
			// two-way link needs an even number of lines, half each way.
			const mutual = link.mutual === true && n >= 2;
			let lineCount = Math.max(1, Math.min(n, Math.round(Math.sqrt(n) * 0.9)));
			if (mutual) lineCount = Math.min(n - (n % 2), lineCount + (lineCount % 2));
			const lineSep = mutual ? sep : 0;
			const turn = rand(key, 0, Salt.Turn) * Math.PI * 2;
			// a line's motes: the first is the line's index, the rest follow
			// every lineCount
			for (let l = 0; l < lineCount; l++) {
				// alternate lines run the other way on a two-way link
				const reverse = mutual && l % 2 === 1;
				// spread evenly around the link, with a little jitter
				let angle = turn + l * golden + (rand(key, l, Salt.Angle) - 0.5) * 0.6;
				// most lines bow a little, a few bow a lot: a spindle
				let bow = 0.15 + 0.85 * Math.pow(rand(key, l, Salt.Bow), 0.8);
				if (lineSep > 0) {
					// each stream gathers around its own anchor, on opposite
					// sides of the link: angles narrow toward the anchor and
					// the least-bowed lines move out, off the shared axis;
					const anchor = turn + (reverse ? Math.PI : 0);
					const relative = Math.atan2(Math.sin(angle - anchor), Math.cos(angle - anchor));
					// (square root: the streams stop overlapping from about halfway)
					angle = anchor + relative * (1 - 0.8 * Math.sqrt(lineSep));
					bow = bow + (1 - bow) * 0.35 * lineSep;
					// and the streams loop further out, up to 2.5x the bow at 1,
					// like two field loops on either side of the link
					bow *= 1 + 1.5 * lineSep;
				}
				const speed = 0.8 + 0.4 * rand(key, l, Salt.Speed);
				const offset = rand(key, l, Salt.Offset);
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				const onLine = Math.ceil((n - l) / lineCount);
				const linkValue = (index + 1) * (reverse ? -1 : 1);
				for (let slot = 0; slot < onLine; slot++) {
					const i = l + slot * lineCount; // this mote's index within the link
					// an evenly spaced train along the line, slightly jittered
					const phase = offset + (slot + (rand(key, i, Salt.Jitter) - 0.5) * 0.15) / onLine;
					position[m * 3] = linkValue;
					position[m * 3 + 1] = phase - Math.floor(phase);
					position[m * 3 + 2] = speed;
					shape[m * 4] = cos;
					shape[m * 4 + 1] = sin;
					shape[m * 4 + 2] = bow;
					// keeps the streams apart even with a small spread
					shape[m * 4 + 3] = bow * lineSep * 0.12;
					look[m * 2] = 0.6 + 0.7 * rand(key, i, Salt.Size);
					look[m * 2 + 1] = rand(key, i, Salt.Twinkle) * Math.PI * 2;
					m++;
				}
			}
		});

		this.ensureMaterial(style);
		this.ensureTexture(links.length);
		this.geometry?.dispose();
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
		geometry.setAttribute("aShape", new THREE.BufferAttribute(shape, 4));
		geometry.setAttribute("aLook", new THREE.BufferAttribute(look, 2));
		geometry.setDrawRange(0, total);
		this.geometry = geometry;
		if (this.points && this.material) this.points.geometry = geometry;
		else if (this.material) {
			this.points = new THREE.Points(geometry, this.material);
			this.points.frustumCulled = false;
			this.points.renderOrder = 5;
			this.points.layers.set(RENDER_LAYER);
			this.scene.add(this.points);
		}
	}

	private ensureMaterial(style: MoteStyle) {
		if (this.material) {
			this.material.blending = style.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
			return;
		}
		this.material = new THREE.ShaderMaterial({
			uniforms: {
				uLinks: { value: null },
				uTime: { value: 0 },
				uSpeed: { value: style.speed },
				uSpread: { value: style.spread },
				uSize: { value: style.size },
				uScale: { value: 400 },
				uFlicker: { value: 0 },
				uSolid: { value: style.solidity },
			},
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			transparent: true,
			depthWrite: false,
			blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
		});
	}

	private ensureTexture(links: number) {
		const height = Math.max(1, Math.ceil((links * LINK_TEXELS) / TEXTURE_WIDTH));
		if (this.texture && this.texture.image.height >= height) return;
		this.texture?.dispose();
		this.textureData = new Float32Array(TEXTURE_WIDTH * height * 4);
		const texture = new THREE.DataTexture(this.textureData, TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
		texture.minFilter = THREE.NearestFilter;
		texture.magFilter = THREE.NearestFilter;
		texture.generateMipmaps = false;
		texture.needsUpdate = true;
		this.texture = texture;
		if (this.material) this.material.uniforms.uLinks.value = texture;
	}

	private color(css: string): THREE.Color {
		let c = this.colorCache.get(css);
		if (!c) {
			c = new THREE.Color();
			// THREE.Color ignores alpha; strip it to avoid warnings
			c.setStyle(css.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, "rgb($1,$2,$3)"));
			this.colorCache.set(css, c);
		}
		return c;
	}

	// Moves the motes along their arcs; dt in seconds. Writes each link's
	// ends, colors and brightness for the shader.
	public update(dt: number, style: MoteStyle, viewportHeight: number) {
		const material = this.material;
		const texture = this.texture;
		if (!material || !texture || !this.points) return;
		this.time += dt;
		const uniforms = material.uniforms;
		uniforms.uTime.value = this.time;
		uniforms.uSpeed.value = style.speed;
		uniforms.uSpread.value = style.spread;
		uniforms.uSize.value = style.size;
		uniforms.uScale.value = viewportHeight / 2;
		uniforms.uFlicker.value = 0.25 * (1 - style.solidity);
		uniforms.uSolid.value = style.solidity;
		material.blending = style.additive ? THREE.AdditiveBlending : THREE.NormalBlending;

		const data = this.textureData;
		let anyVisible = false;
		for (let i = 0; i < this.links.length; i++) {
			const link = this.links[i];
			const o = i * LINK_TEXELS * 4;
			const s = link.source as Endpoint;
			const t = link.target as Endpoint;
			const bright =
				typeof s === "string" || typeof t === "string" || s.x === undefined || t.x === undefined
					? 0
					: style.brightness(link);
			data[o + 11] = bright; // source color texel's alpha
			if (bright <= 0) continue;
			anyVisible = true;
			const a = s as Positioned;
			const b = t as Positioned;
			data[o] = a.x ?? 0;
			data[o + 1] = a.y ?? 0;
			data[o + 2] = a.z ?? 0;
			data[o + 4] = b.x ?? 0;
			data[o + 5] = b.y ?? 0;
			data[o + 6] = b.z ?? 0;
			const [fromCss, toCss] = style.colors(link);
			const from = this.color(fromCss);
			const to = this.color(toCss);
			data[o + 8] = from.r;
			data[o + 9] = from.g;
			data[o + 10] = from.b;
			data[o + 12] = to.r;
			data[o + 13] = to.g;
			data[o + 14] = to.b;
		}
		// nothing lit (lines mode with nothing hovered): skip the draw
		this.points.visible = anyVisible && this.moteCount > 0;
		if (anyVisible) texture.needsUpdate = true;
	}

	// forget cached colors (theme or cluster colors changed)
	public clearColors() {
		this.colorCache.clear();
	}

	public dispose() {
		if (this.points) this.scene.remove(this.points);
		this.geometry?.dispose();
		this.material?.dispose();
		this.texture?.dispose();
		this.points = null;
		this.geometry = null;
		this.material = null;
		this.texture = null;
		this.links = [];
		this.moteCount = 0;
	}
}
