// three is bundled through 3d-force-graph and ships no type declarations at
// this version; these cover only what the label sprites, reverse arrows,
// motes and the batched renderer (GraphBatches) use, as of three r146.
declare module "three" {
	export class Layers {
		set(layer: number): void;
		enable(layer: number): void;
		disable(layer: number): void;
		test(layers: Layers): boolean;
	}
	export class Vector3 {
		constructor(x?: number, y?: number, z?: number);
		x: number;
		y: number;
		z: number;
		set(x: number, y: number, z: number): this;
		applyMatrix4(m: Matrix4): this;
		fromBufferAttribute(attribute: BufferAttribute, index: number): this;
		toArray(array: Float32Array | number[], offset?: number): Float32Array | number[];
	}
	export class Matrix4 {
		elements: number[];
		copy(m: Matrix4): this;
		// right-multiplies by a scale: this × S(v)
		scale(v: Vector3): this;
		toArray(array: Float32Array | number[], offset?: number): Float32Array | number[];
	}
	export class Object3D {
		position: Vector3;
		scale: Vector3;
		matrixWorld: Matrix4;
		layers: Layers;
		visible: boolean;
		renderOrder: number;
		frustumCulled: boolean;
		parent: Object3D | null;
		children: Object3D[];
		add(...objects: Object3D[]): this;
		remove(...objects: Object3D[]): this;
		traverse(callback: (object: Object3D) => void): void;
		localToWorld(vector: Vector3): Vector3;
		lookAt(vector: Vector3): void;
		raycast(...args: unknown[]): void;
		onBeforeRender: (...args: unknown[]) => void;
	}
	export class Scene extends Object3D {}
	export class Group extends Object3D {
		readonly isGroup: true;
	}
	export class Light extends Object3D {
		readonly isLight: true;
	}

	export class BufferAttribute {
		constructor(array: Float32Array, itemSize: number);
		array: Float32Array;
		count: number;
		needsUpdate: boolean;
		// the part of the array to upload on the next render; reset afterwards
		updateRange: { offset: number; count: number };
		setUsage(usage: number): this;
	}
	export class InstancedBufferAttribute extends BufferAttribute {}
	export class BufferGeometry {
		attributes: Record<string, BufferAttribute>;
		// the constructor arguments of the built-in shapes
		parameters?: Record<string, number>;
		setAttribute(name: string, attribute: BufferAttribute): this;
		setDrawRange(start: number, count: number): void;
		translate(x: number, y: number, z: number): this;
		rotateX(angle: number): this;
		dispose(): void;
	}
	export class SphereGeometry extends BufferGeometry {
		constructor(radius?: number, widthSegments?: number, heightSegments?: number);
	}
	export class CylinderGeometry extends BufferGeometry {
		constructor(
			radiusTop?: number,
			radiusBottom?: number,
			height?: number,
			radialSegments?: number,
			heightSegments?: number,
			openEnded?: boolean
		);
	}
	export class ConeGeometry extends BufferGeometry {
		constructor(radius: number, height: number, radialSegments?: number);
	}

	export class Color {
		constructor(color?: string | number);
		r: number;
		g: number;
		b: number;
		setStyle(style: string): this;
	}
	export class Material {
		opacity: number;
		transparent: boolean;
		depthWrite: boolean;
		dispose(): void;
	}
	export interface Shader {
		vertexShader: string;
		fragmentShader: string;
	}
	export class MeshLambertMaterial extends Material {
		constructor(params: { color?: Color | number; transparent?: boolean; depthWrite?: boolean });
		color: Color;
		onBeforeCompile: (shader: Shader) => void;
		customProgramCacheKey: () => string;
	}
	export class LineBasicMaterial extends Material {
		constructor(params: { vertexColors?: boolean; transparent?: boolean; depthWrite?: boolean });
	}
	export class ShaderMaterial extends Material {
		constructor(params: {
			uniforms?: Record<string, { value: unknown }>;
			vertexShader?: string;
			fragmentShader?: string;
			transparent?: boolean;
			depthWrite?: boolean;
			blending?: number;
		});
		uniforms: Record<string, { value: number }>;
		blending: number;
	}
	export class SpriteMaterial extends Material {
		constructor(params: { map?: CanvasTexture; transparent?: boolean; depthWrite?: boolean });
	}
	export class CanvasTexture {
		constructor(canvas: HTMLCanvasElement);
		minFilter: number;
		generateMipmaps: boolean;
	}

	export class Mesh extends Object3D {
		constructor(geometry: BufferGeometry, material: Material);
		readonly isMesh: true;
		geometry: BufferGeometry;
		material: Material;
	}
	export class InstancedMesh extends Mesh {
		constructor(geometry: BufferGeometry, material: Material, count: number);
		count: number;
		instanceMatrix: InstancedBufferAttribute;
		dispose(): void;
	}
	export class Line extends Object3D {
		readonly isLine: true;
		geometry: BufferGeometry;
		material: Material;
	}
	export class LineSegments extends Line {
		constructor(geometry: BufferGeometry, material: Material);
	}
	export class Sprite extends Object3D {
		constructor(material: SpriteMaterial);
		material: SpriteMaterial;
	}
	export class Points extends Object3D {
		constructor(geometry: BufferGeometry, material: ShaderMaterial);
	}

	export const LinearFilter: number;
	export const AdditiveBlending: number;
	export const NormalBlending: number;
	export const DynamicDrawUsage: number;
}
