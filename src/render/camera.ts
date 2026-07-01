import { mat4, vec3 } from "gl-matrix";

// RTS fly camera (plan Phase 2 exit: "fly the camera"). Z-up to match WC3 world
// space. Orbits a ground target: WASD/arrows pan, drag rotates, wheel zooms.

export class FlyCamera {
  private target = vec3.fromValues(0, 0, 0);
  private distance = 3000;
  private yaw = -Math.PI / 2; // looking toward +Y
  private pitch = 0.9; // radians above the ground plane
  private keys = new Set<string>();
  private dragging = false;

  attach(canvas: HTMLCanvasElement): void {
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.yaw += e.movementX * 0.005;
      this.pitch = clamp(this.pitch - e.movementY * 0.005, 0.15, 1.5);
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.distance = clamp(this.distance * (1 + Math.sign(e.deltaY) * 0.1), 300, 12000);
      },
      { passive: false },
    );
  }

  /** Advance panning from held keys. */
  update(dt: number): void {
    const speed = this.distance * 1.2 * dt;
    const fwd: [number, number] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const right: [number, number] = [fwd[1], -fwd[0]];
    const move = (dx: number, dy: number) => {
      this.target[0] += dx;
      this.target[1] += dy;
    };
    if (this.keys.has("w") || this.keys.has("arrowup")) move(fwd[0] * speed, fwd[1] * speed);
    if (this.keys.has("s") || this.keys.has("arrowdown")) move(-fwd[0] * speed, -fwd[1] * speed);
    if (this.keys.has("d") || this.keys.has("arrowright")) move(right[0] * speed, right[1] * speed);
    if (this.keys.has("a") || this.keys.has("arrowleft")) move(-right[0] * speed, -right[1] * speed);
  }

  viewProj(aspect: number): Float32Array {
    const cp = Math.cos(this.pitch);
    const eye = vec3.fromValues(
      this.target[0] - Math.cos(this.yaw) * cp * this.distance,
      this.target[1] - Math.sin(this.yaw) * cp * this.distance,
      this.target[2] + Math.sin(this.pitch) * this.distance,
    );
    const proj = mat4.perspective(mat4.create(), Math.PI / 4, aspect, 10, 40000);
    const view = mat4.lookAt(mat4.create(), eye, this.target, [0, 0, 1]);
    const out = new Float32Array(16);
    mat4.multiply(out, proj, view);
    return out;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
