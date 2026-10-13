// A deliberately small WebGL2 toolkit: programs with reflected uniforms,
// HDR render targets and a vertex-buffer-free fullscreen triangle.

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class GPU {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    this.gl = gl;
    this.canvas = canvas;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.floatTargets) this.halfTargets = !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.hdrFormat = this.floatTargets || this.halfTargets
      ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    this.hdr = this.floatTargets || this.halfTargets;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  program(name, fsSource, vsSource = FULLSCREEN_VS) {
    return new Program(this.gl, name, vsSource, fsSource);
  }

  texture2D(w, h, { internal, format, type, filter, wrap, data = null } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal ?? this.hdrFormat.internal, w, h, 0,
      format ?? this.hdrFormat.format, type ?? this.hdrFormat.type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter ?? gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter ?? gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap ?? gl.CLAMP_TO_EDGE);
    return tex;
  }

  target(w, h) {
    const gl = this.gl;
    const tex = this.texture2D(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete (0x${status.toString(16)})`);
    return { fb, tex, w, h };
  }

  dispose(target) {
    if (!target) return;
    this.gl.deleteFramebuffer(target.fb);
    this.gl.deleteTexture(target.tex);
  }

  // Draw a fullscreen pass into `target` (null = the canvas).
  pass(program, target, uniforms = {}, viewport = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = viewport ? viewport[0] : target ? target.w : gl.drawingBufferWidth;
    const h = viewport ? viewport[1] : target ? target.h : gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    program.use(uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

class Program {
  constructor(gl, name, vs, fs) {
    this.gl = gl;
    this.name = name;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs, name));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs, name));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`[${name}] link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    this.uniforms = new Map();
    let unit = 0;
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      const loc = gl.getUniformLocation(prog, info.name);
      const sampler = info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_CUBE || info.type === gl.SAMPLER_3D;
      this.uniforms.set(info.name, {
        loc,
        type: info.type,
        unit: sampler ? unit++ : -1,
        target: info.type === gl.SAMPLER_CUBE ? gl.TEXTURE_CUBE_MAP : info.type === gl.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D,
      });
    }
  }

  use(values) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    for (const key in values) {
      const u = this.uniforms.get(key);
      if (!u) continue; // optimised away or unused in this program
      const v = values[key];
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
        case gl.SAMPLER_2D: case gl.SAMPLER_CUBE: case gl.SAMPLER_3D:
          gl.activeTexture(gl.TEXTURE0 + u.unit);
          gl.bindTexture(u.target, v);
          gl.uniform1i(u.loc, u.unit);
          break;
        default: throw new Error(`[${this.name}] unsupported uniform type for ${key}`);
      }
    }
  }
}

function compile(gl, type, source, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = source.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(numbered);
    throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}`);
  }
  return sh;
}
