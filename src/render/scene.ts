import type { Renderer } from "./renderer";
import { FlyCamera } from "./camera";
import { boxGeometry } from "./primitives";
import type { TerrainMesh } from "./terrainMesh";
import type { DoodadInstance } from "../world/doodads";

// Phase 2 scene: a lit terrain heightmap + instanced placeholder doodad boxes,
// viewed through the fly camera. WebGL2 for 32-bit indices (big maps exceed 65k
// vertices) and native instancing. Renderer interface keeps sim/UI decoupled.

const LIGHT = [0.3, 0.35, 0.87]; // world-space (Z-up) directional light

const TERRAIN_VERT = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec3 aColor;
uniform mat4 uVP;
out vec3 vNormal; out vec3 vColor;
void main() { vNormal = aNormal; vColor = aColor; gl_Position = uVP * vec4(aPos, 1.0); }`;

const LIT_FRAG = `#version 300 es
precision mediump float;
in vec3 vNormal; in vec3 vColor;
uniform vec3 uLight;
out vec4 frag;
void main() {
  float d = max(dot(normalize(vNormal), normalize(uLight)), 0.0);
  frag = vec4(vColor * (0.4 + 0.6 * d), 1.0);
}`;

const DOODAD_VERT = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec4 aInstance; in vec3 aColor;
uniform mat4 uVP;
out vec3 vNormal; out vec3 vColor;
void main() {
  vNormal = aNormal; vColor = aColor;
  vec3 world = vec3(aPos.xy * aInstance.w + aInstance.xy, aPos.z * aInstance.w + aInstance.z);
  gl_Position = uVP * vec4(world, 1.0);
}`;

export class TerrainScene implements Renderer {
  private gl: WebGL2RenderingContext;
  private camera = new FlyCamera();
  private terrainProgram: WebGLProgram;
  private doodadProgram: WebGLProgram;
  private terrainVao: WebGLVertexArrayObject | null = null;
  private terrainIndexCount = 0;
  private doodadVao: WebGLVertexArrayObject | null = null;
  private doodadCount = 0;
  private raf = 0;
  private last = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.terrainProgram = link(gl, TERRAIN_VERT, LIT_FRAG);
    this.doodadProgram = link(gl, DOODAD_VERT, LIT_FRAG);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.05, 0.06, 0.09, 1);
    this.camera.attach(canvas);
  }

  setTerrain(mesh: TerrainMesh): void {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.attrib(this.terrainProgram, "aPos", mesh.positions, 3);
    this.attrib(this.terrainProgram, "aNormal", mesh.normals, 3);
    this.attrib(this.terrainProgram, "aColor", mesh.colors, 3);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.terrainVao = vao;
    this.terrainIndexCount = mesh.indices.length;
  }

  setDoodads(doodads: DoodadInstance[]): void {
    const gl = this.gl;
    const box = boxGeometry();
    const instances = new Float32Array(doodads.length * 4);
    const colors = new Float32Array(doodads.length * 3);
    doodads.forEach((d, i) => {
      const size = Math.max(24, 48 * (d.scale[0] || 1));
      instances.set([d.x, d.y, d.z, size], i * 4);
      colors.set(idColor(d.id), i * 3);
    });

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this.attrib(this.doodadProgram, "aPos", box.positions, 3);
    this.attrib(this.doodadProgram, "aNormal", box.normals, 3);
    this.instanced(this.doodadProgram, "aInstance", instances, 4);
    this.instanced(this.doodadProgram, "aColor", colors, 3);
    gl.bindVertexArray(null);
    this.doodadVao = vao;
    this.doodadCount = doodads.length;
  }

  start(): void {
    const frame = (t: number) => {
      const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0;
      this.last = t;
      this.camera.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const gl = this.gl;
    this.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.camera.viewProj(this.canvas.width / this.canvas.height || 1);

    if (this.terrainVao) {
      gl.useProgram(this.terrainProgram);
      this.setCommonUniforms(this.terrainProgram, vp);
      gl.bindVertexArray(this.terrainVao);
      gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    }
    if (this.doodadVao && this.doodadCount) {
      gl.useProgram(this.doodadProgram);
      this.setCommonUniforms(this.doodadProgram, vp);
      gl.bindVertexArray(this.doodadVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.doodadCount);
    }
    gl.bindVertexArray(null);
  }

  private setCommonUniforms(program: WebGLProgram, vp: Float32Array): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "uVP"), false, vp);
    gl.uniform3fv(gl.getUniformLocation(program, "uLight"), LIGHT);
  }

  private attrib(program: WebGLProgram, name: string, data: Float32Array, size: number): void {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private instanced(program: WebGLProgram, name: string, data: Float32Array, size: number): void {
    this.attrib(program, name, data, size);
    const gl = this.gl;
    gl.vertexAttribDivisor(gl.getAttribLocation(program, name), 1);
  }

  private resize(): void {
    const { canvas, gl } = this;
    const w = Math.floor(canvas.clientWidth * devicePixelRatio);
    const h = Math.floor(canvas.clientHeight * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
}

function idColor(id: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const base = (Math.abs(hash) % 40) / 100;
  return [0.35 + base, 0.28 + base * 0.6, 0.2 + base * 0.3];
}

function link(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}
