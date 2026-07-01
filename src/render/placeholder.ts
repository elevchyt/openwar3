import { mat4 } from "gl-matrix";
import type { Renderer } from "./renderer";

// Phase 0 placeholder renderer: draws a rotating box via raw WebGL, proving the
// engine renders *something* with zero assets loaded (plan §0, §2). This lives
// behind the Renderer interface so the real mdx-m3-viewer renderer drops in later.

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
varying vec3 vNormal;
void main() {
  vNormal = aNormal;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vNormal;
void main() {
  float light = max(dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.6))), 0.15);
  gl_FragColor = vec4(vec3(0.35, 0.55, 0.85) * light, 1.0);
}`;

// Unit cube: 6 faces, 2 tris each, with per-face normals.
function cube(): { positions: Float32Array; normals: Float32Array } {
  const faces = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const f of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(...f.v[i]);
      normals.push(...f.n);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
  }
  return s;
}

export class PlaceholderRenderer implements Renderer {
  private gl: WebGLRenderingContext;
  private raf = 0;
  private angle = 0;
  private last = 0;
  private program: WebGLProgram;
  private vertexCount: number;
  private loc: { model: WebGLUniformLocation; viewProj: WebGLUniformLocation };

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    }
    this.program = program;

    const { positions, normals } = cube();
    this.vertexCount = positions.length / 3;
    this.bindAttribute("aPos", positions, 3);
    this.bindAttribute("aNormal", normals, 3);

    this.loc = {
      model: gl.getUniformLocation(program, "uModel")!,
      viewProj: gl.getUniformLocation(program, "uViewProj")!,
    };

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.04, 0.05, 0.08, 1);
  }

  private bindAttribute(name: string, data: Float32Array, size: number): void {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private resize(): void {
    const { canvas, gl } = this;
    const w = canvas.clientWidth * devicePixelRatio;
    const h = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  start(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    const frame = (t: number) => {
      const dt = this.last ? (t - this.last) / 1000 : 0;
      this.last = t;
      this.angle += dt * 0.6;
      this.resize();

      const aspect = this.canvas.width / this.canvas.height || 1;
      const proj = mat4.perspective(mat4.create(), Math.PI / 4, aspect, 0.1, 100);
      const view = mat4.lookAt(mat4.create(), [4, 3, 5], [0, 0, 0], [0, 1, 0]);
      const viewProj = mat4.multiply(mat4.create(), proj, view);
      const model = mat4.fromYRotation(mat4.create(), this.angle);

      gl.uniformMatrix4fv(this.loc.viewProj, false, viewProj);
      gl.uniformMatrix4fv(this.loc.model, false, model);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
