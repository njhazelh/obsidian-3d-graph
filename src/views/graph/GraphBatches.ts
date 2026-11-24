import * as THREE from "three";
import Link from "../../graph/Link";
import Node from "../../graph/Node";

// Draws the graph's node spheres, link cylinders, link lines and arrowheads
// in a few batches instead of one draw call per object.
//
// three-forcegraph keeps building one three.js object per node and link.
// Those objects stay in the scene for hover, click and drag (the library
// raycasts them), but the camera no longer renders their layer: it renders
// RENDER_LAYER, where these batches copy each object's transform, color and
// opacity just before every frame is drawn. Arrowheads aren't objects at
// all: the batch places them from the node positions.

// the layer the camera renders; three-forcegraph's objects stay on layer 0
export const RENDER_LAYER = 1;

// what three-forcegraph hangs on the graph data
type GraphObject = THREE.Object3D & {
	__graphDefaultObj?: boolean;
	geometry?: THREE.BufferGeometry & { parameters?: Record<string, number> };
	material?: THREE.Material & { color?: THREE.Color; opacity: number };
};
type NodeWithObject = Node & { __threeObj?: GraphObject };
type LinkWithObjects = Link & { __lineObj?: GraphObject };

// the parts of the graph the batches need from the 3D graph instance
export interface BatchSource {
	scene(): THREE.Scene;
	graphData(): { nodes: object[]; links: object[] };
	nodeResolution(): number;
	linkResolution(): number;
	// called once at the start of each frame, before the methods below
	beginFrame(): void;
	// radius of a link's cylinder, as three-forcegraph would make it
	linkRadius(link: Link): number;
	// arrowhead length (0 for no arrowheads), color, and how far from a
	// node's center an arrowhead touching it ends
	arrowLength(): number;
	arrowColor(link: Link): THREE.Color;
	arrowOffset(node: Node): number;
}

// Lambert material with a per-instance color and opacity (three r146's
// instanceColor has no alpha)
const instancedLambert = (transparent: boolean, depthWrite: boolean) => {
	const material = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent, depthWrite });
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace(
				"#include <common>",
				"#include <common>\nattribute vec4 instanceRGBA;\nvarying vec4 vInstanceRGBA;"
			)
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvInstanceRGBA = instanceRGBA;");
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying vec4 vInstanceRGBA;")
			.replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor *= vInstanceRGBA;");
	};
	material.customProgramCacheKey = () => `graph-batch-${transparent}-${depthWrite}`;
	return material;
};

// One InstancedMesh, refilled every frame
class InstancedBatch {
	private mesh: THREE.InstancedMesh | null = null;
	private rgba: THREE.InstancedBufferAttribute | null = null;
	private capacity = 0;
	private count = 0;
	private readonly material: THREE.MeshLambertMaterial;
	private readonly renderOrder: number;

	constructor(
		private readonly scene: THREE.Scene,
		private geometry: THREE.BufferGeometry,
		{ transparent, depthWrite, renderOrder }: { transparent: boolean; depthWrite: boolean; renderOrder: number }
	) {
		this.renderOrder = renderOrder;
		this.material = instancedLambert(transparent, depthWrite);
	}

	// Starts a frame; `max` is the most instances it can get
	begin(max: number) {
		this.count = 0;
		if (max > this.capacity) this.allocate(Math.ceil(max * 1.25));
	}

	push(matrix: THREE.Matrix4, color: THREE.Color, alpha: number) {
		const mesh = this.mesh;
		const rgba = this.rgba;
		if (!mesh || !rgba || this.count >= this.capacity) return;
		matrix.toArray(mesh.instanceMatrix.array, this.count * 16);
		const a = rgba.array as Float32Array;
		const o = this.count * 4;
		a[o] = color.r;
		a[o + 1] = color.g;
		a[o + 2] = color.b;
		a[o + 3] = alpha;
		this.count++;
	}

	end() {
		const mesh = this.mesh;
		const rgba = this.rgba;
		if (!mesh || !rgba) return;
		mesh.count = this.count;
		mesh.visible = this.count > 0;
		if (this.count === 0) return;
		mesh.instanceMatrix.updateRange.offset = 0;
		mesh.instanceMatrix.updateRange.count = this.count * 16;
		mesh.instanceMatrix.needsUpdate = true;
		rgba.updateRange.offset = 0;
		rgba.updateRange.count = this.count * 4;
		rgba.needsUpdate = true;
	}

	setGeometry(geometry: THREE.BufferGeometry) {
		this.geometry.dispose();
		this.geometry = geometry;
		if (this.rgba) geometry.setAttribute("instanceRGBA", this.rgba);
		if (this.mesh) this.mesh.geometry = geometry;
	}

	private allocate(capacity: number) {
		this.removeMesh();
		const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
		mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		const rgba = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
		rgba.setUsage(THREE.DynamicDrawUsage);
		this.geometry.setAttribute("instanceRGBA", rgba);
		mesh.count = 0;
		// instances can be anywhere, and nothing should raycast the batch
		mesh.frustumCulled = false;
		mesh.raycast = () => undefined;
		mesh.layers.set(RENDER_LAYER);
		mesh.renderOrder = this.renderOrder;
		this.scene.add(mesh);
		this.mesh = mesh;
		this.rgba = rgba;
		this.capacity = capacity;
	}

	private removeMesh() {
		if (!this.mesh) return;
		this.scene.remove(this.mesh);
		this.mesh.dispose();
		this.mesh = null;
		this.rgba = null;
		this.capacity = 0;
	}

	dispose() {
		this.removeMesh();
		this.geometry.dispose();
		this.material.dispose();
	}
}

// Link lines (links of width 0), refilled every frame
class LineBatch {
	private lines: THREE.LineSegments | null = null;
	private capacity = 0;
	private count = 0;
	private readonly material = new THREE.LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		depthWrite: false,
	});

	constructor(private readonly scene: THREE.Scene, private readonly renderOrder: number) {}

	begin(max: number) {
		this.count = 0;
		if (max > this.capacity) this.allocate(Math.ceil(max * 1.25));
	}

	push(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, alpha: number) {
		if (!this.lines || this.count >= this.capacity) return;
		const geometry = this.lines.geometry;
		const pos = geometry.attributes.position.array as Float32Array;
		const col = geometry.attributes.color.array as Float32Array;
		const p = this.count * 6;
		a.toArray(pos, p);
		b.toArray(pos, p + 3);
		const c = this.count * 8;
		for (const o of [c, c + 4]) {
			col[o] = color.r;
			col[o + 1] = color.g;
			col[o + 2] = color.b;
			col[o + 3] = alpha;
		}
		this.count++;
	}

	end() {
		if (!this.lines) return;
		const geometry = this.lines.geometry;
		geometry.setDrawRange(0, this.count * 2);
		this.lines.visible = this.count > 0;
		if (this.count === 0) return;
		const position = geometry.attributes.position as THREE.BufferAttribute;
		const color = geometry.attributes.color as THREE.BufferAttribute;
		position.updateRange.offset = 0;
		position.updateRange.count = this.count * 6;
		position.needsUpdate = true;
		color.updateRange.offset = 0;
		color.updateRange.count = this.count * 8;
		color.needsUpdate = true;
	}

	private allocate(capacity: number) {
		this.removeLines();
		const geometry = new THREE.BufferGeometry();
		const position = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
		const color = new THREE.BufferAttribute(new Float32Array(capacity * 8), 4);
		position.setUsage(THREE.DynamicDrawUsage);
		color.setUsage(THREE.DynamicDrawUsage);
		geometry.setAttribute("position", position);
		geometry.setAttribute("color", color);
		const lines = new THREE.LineSegments(geometry, this.material);
		lines.frustumCulled = false;
		lines.raycast = () => undefined;
		lines.layers.set(RENDER_LAYER);
		lines.renderOrder = this.renderOrder;
		this.scene.add(lines);
		this.lines = lines;
		this.capacity = capacity;
	}

	private removeLines() {
		if (!this.lines) return;
		this.scene.remove(this.lines);
		this.lines.geometry.dispose();
		this.lines = null;
		this.capacity = 0;
	}

	dispose() {
		this.removeLines();
		this.material.dispose();
	}
}

// unit shapes in three-forcegraph's conventions
const unitSphere = (resolution: number) => new THREE.SphereGeometry(1, resolution, resolution);
// a cylinder of radius 1 from z = 0 to z = 1
const unitCylinder = (resolution: number) =>
	new THREE.CylinderGeometry(1, 1, 1, resolution, 1, false)
		.translate(0, 0.5, 0)
		.rotateX(Math.PI / 2);
// a cone of length 1 with its base at the origin, pointing along +z
const unitCone = () =>
	new THREE.ConeGeometry(0.25, 1, 8).translate(0, 0.5, 0).rotateX(Math.PI / 2);

const WHITE = new THREE.Color(0xffffff);
// opacity at or above this draws in the opaque batch
const OPAQUE = 0.999;
// opacity at or below this isn't drawn
const INVISIBLE = 0.001;
// Links draw just before labels (10), so a label always covers the links
// behind it: a batch sorts as one object at the origin, so at the labels'
// order the far half of the labels would draw before every link
const LINK_ORDER = 9;
// as three-forcegraph's materials: spheres write depth even when
// translucent (a dimmed node hides what's behind it), translucent links don't
const OPAQUE_NODES = { transparent: false, depthWrite: true, renderOrder: 0 };
const TRANSLUCENT_NODES = { transparent: true, depthWrite: true, renderOrder: 0 };
const OPAQUE_LINKS = { transparent: false, depthWrite: true, renderOrder: LINK_ORDER };
const TRANSLUCENT_LINKS = { transparent: true, depthWrite: false, renderOrder: LINK_ORDER };

export class GraphBatches {
	private readonly nodesOpaque: InstancedBatch;
	private readonly nodesTranslucent: InstancedBatch;
	private readonly linksOpaque: InstancedBatch;
	private readonly linksTranslucent: InstancedBatch;
	private readonly arrows: InstancedBatch;
	private readonly lines: LineBatch;
	private nodeResolution: number;
	private linkResolution: number;
	private readonly previousBeforeRender: THREE.Scene["onBeforeRender"];

	// scratch objects, reused every frame
	private readonly matrix = new THREE.Matrix4();
	private readonly scale = new THREE.Vector3();
	private readonly a = new THREE.Vector3();
	private readonly b = new THREE.Vector3();
	private readonly translucentNodes: { obj: GraphObject; depth: number }[] = [];

	constructor(private readonly source: BatchSource) {
		const scene = source.scene();
		this.nodeResolution = source.nodeResolution();
		this.linkResolution = source.linkResolution();
		this.nodesOpaque = new InstancedBatch(scene, unitSphere(this.nodeResolution), OPAQUE_NODES);
		this.nodesTranslucent = new InstancedBatch(scene, unitSphere(this.nodeResolution), TRANSLUCENT_NODES);
		this.linksOpaque = new InstancedBatch(scene, unitCylinder(this.linkResolution), OPAQUE_LINKS);
		this.linksTranslucent = new InstancedBatch(scene, unitCylinder(this.linkResolution), TRANSLUCENT_LINKS);
		this.arrows = new InstancedBatch(scene, unitCone(), OPAQUE_NODES);
		this.lines = new LineBatch(scene, LINK_ORDER);

		// runs after the scene's matrices are updated and before anything is
		// drawn, so the batches show this frame's positions
		this.previousBeforeRender = scene.onBeforeRender;
		scene.onBeforeRender = (...args) => {
			this.previousBeforeRender.apply(scene, args);
			// (renderer, scene, camera, ...)
			this.update(args[2] as THREE.Object3D);
		};
	}

	private update(camera: THREE.Object3D) {
		// lights only light anything if the camera's layer sees them; the
		// library adds its lights after the batches exist, so check each frame
		for (const child of this.source.scene().children)
			if ((child as THREE.Light).isLight) child.layers.enable(RENDER_LAYER);
		const { nodes, links } = this.source.graphData();
		// new graph data whose objects the library hasn't made yet (it makes
		// them a moment after the data is set): keep drawing the last frame's,
		// as the library's old objects are still what's in the scene
		if (nodes.length > 0 && !(nodes as NodeWithObject[]).some((n) => n.__threeObj)) return;
		this.source.beginFrame();
		this.updateGeometries();
		this.updateNodes(nodes as NodeWithObject[], camera);
		this.updateLinks(links as LinkWithObjects[]);
	}

	private updateGeometries() {
		const nodeResolution = this.source.nodeResolution();
		if (nodeResolution !== this.nodeResolution) {
			this.nodeResolution = nodeResolution;
			this.nodesOpaque.setGeometry(unitSphere(nodeResolution));
			this.nodesTranslucent.setGeometry(unitSphere(nodeResolution));
		}
		const linkResolution = this.source.linkResolution();
		if (linkResolution !== this.linkResolution) {
			this.linkResolution = linkResolution;
			this.linksOpaque.setGeometry(unitCylinder(linkResolution));
			this.linksTranslucent.setGeometry(unitCylinder(linkResolution));
		}
	}

	// a node is the library's default sphere: a mesh at the node's position.
	// Translucent spheres (dimmed by a hover) write depth, so they're drawn
	// farthest first, as three sorts separate transparent objects: otherwise
	// a near one drawn first would hide a far one that should show through it
	private updateNodes(nodes: NodeWithObject[], camera: THREE.Object3D) {
		this.nodesOpaque.begin(nodes.length);
		this.nodesTranslucent.begin(nodes.length);
		const translucent = this.translucentNodes;
		translucent.length = 0;
		const c = camera.matrixWorld.elements;
		for (const node of nodes) {
			const obj = node.__threeObj;
			if (!obj || !obj.__graphDefaultObj || !obj.material?.color) continue;
			const alpha = obj.material.opacity;
			if (alpha <= INVISIBLE) continue;
			if (alpha < OPAQUE) {
				const m = obj.matrixWorld.elements;
				const depth = (m[12] - c[12]) ** 2 + (m[13] - c[13]) ** 2 + (m[14] - c[14]) ** 2;
				translucent.push({ obj, depth });
				continue;
			}
			this.pushNode(this.nodesOpaque, obj, alpha);
		}
		translucent.sort((a, b) => b.depth - a.depth);
		for (const { obj } of translucent) this.pushNode(this.nodesTranslucent, obj, obj.material?.opacity ?? 1);
		this.nodesOpaque.end();
		this.nodesTranslucent.end();
	}

	private pushNode(batch: InstancedBatch, obj: GraphObject, alpha: number) {
		const r = obj.geometry?.parameters?.radius ?? 1;
		this.matrix.copy(obj.matrixWorld).scale(this.scale.set(r, r, r));
		batch.push(this.matrix, obj.material?.color ?? WHITE, Math.min(1, alpha));
	}

	// a link is the library's cylinder or line; its arrowheads are placed
	// here, from its nodes
	private updateLinks(links: LinkWithObjects[]) {
		const arrowLength = this.source.arrowLength();
		this.linksOpaque.begin(links.length);
		this.linksTranslucent.begin(links.length);
		this.lines.begin(links.length);
		this.arrows.begin(arrowLength > 0 ? links.length * 2 : 0);
		for (const link of links) {
			const line = link.__lineObj;
			if (line) this.pushLink(link, line);
			if (arrowLength > 0) this.pushArrows(link, arrowLength);
		}
		this.linksOpaque.end();
		this.linksTranslucent.end();
		this.lines.end();
		this.arrows.end();
	}

	private pushLink(link: Link, line: GraphObject) {
		const material = line.material;
		if (!material?.color) return;
		const alpha = Math.min(1, material.opacity);
		if (alpha <= INVISIBLE) return;
		if ((line as THREE.Mesh).isMesh) {
			// the cylinder's radius comes from the plugin, not the library's
			// mesh, so highlighting a link doesn't make the library rebuild them
			const r = this.source.linkRadius(link);
			if (r <= 0) return;
			this.matrix.copy(line.matrixWorld).scale(this.scale.set(r, r, 1));
			(alpha >= OPAQUE ? this.linksOpaque : this.linksTranslucent).push(this.matrix, material.color, alpha);
		} else if ((line as THREE.Line).isLine) {
			const position = line.geometry?.attributes.position;
			if (!position || position.count < 2) return;
			this.a.fromBufferAttribute(position, 0).applyMatrix4(line.matrixWorld);
			this.b.fromBufferAttribute(position, position.count - 1).applyMatrix4(line.matrixWorld);
			this.lines.push(this.a, this.b, material.color, alpha);
		}
	}

	// Like three-forcegraph's arrowheads: the forward one ends `offset` short
	// of the target's center, pointing at it; a two-way link also gets one
	// ending short of the source, pointing back at it
	private pushArrows(link: Link, length: number) {
		const source = link.source as NodeWithObject | string;
		const target = link.target as NodeWithObject | string;
		if (typeof source !== "object" || typeof target !== "object") return;
		const s = source.__threeObj?.matrixWorld.elements;
		const t = target.__threeObj?.matrixWorld.elements;
		if (!s || !t) return;
		const dx = t[12] - s[12];
		const dy = t[13] - s[13];
		const dz = t[14] - s[14];
		const len = Math.hypot(dx, dy, dz);
		if (!len) return;
		const ux = dx / len;
		const uy = dy / len;
		const uz = dz / len;
		const color = this.source.arrowColor(link);
		// tail = head - direction × length
		const toTarget = len - this.source.arrowOffset(target);
		this.pushArrow(s[12] + ux * (toTarget - length), s[13] + uy * (toTarget - length), s[14] + uz * (toTarget - length), ux, uy, uz, length, color);
		if (link.mutual) {
			const toSource = len - this.source.arrowOffset(source);
			this.pushArrow(t[12] - ux * (toSource - length), t[13] - uy * (toSource - length), t[14] - uz * (toSource - length), -ux, -uy, -uz, length, color);
		}
	}

	// a cone with its base at (x, y, z), pointing along the unit vector u
	private pushArrow(x: number, y: number, z: number, ux: number, uy: number, uz: number, length: number, color: THREE.Color) {
		// two unit vectors perpendicular to u (the cone looks the same
		// whichever way it's turned about u)
		const upY = Math.abs(uy) < 0.99;
		const rx = upY ? 0 : 1, ry = upY ? 1 : 0;
		let px = ry * uz, py = -rx * uz, pz = rx * uy - ry * ux; // r × u
		const pl = Math.hypot(px, py, pz) || 1;
		px /= pl;
		py /= pl;
		pz /= pl;
		const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px; // u × p
		const e = this.matrix.elements;
		e[0] = px * length; e[1] = py * length; e[2] = pz * length; e[3] = 0;
		e[4] = qx * length; e[5] = qy * length; e[6] = qz * length; e[7] = 0;
		e[8] = ux * length; e[9] = uy * length; e[10] = uz * length; e[11] = 0;
		e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
		this.arrows.push(this.matrix, color, 1);
	}

	dispose() {
		const scene = this.source.scene();
		scene.onBeforeRender = this.previousBeforeRender;
		[this.nodesOpaque, this.nodesTranslucent, this.linksOpaque, this.linksTranslucent, this.arrows, this.lines].forEach(
			(batch) => batch.dispose()
		);
	}
}
