import { compileShader, createProgram, createTexture, createFramebuffer } from './glUtils'
import { GEOMETRY_VERT, GEOMETRY_FRAG } from './shaders/geometry'
import { ADJUSTMENT_VERT, ADJUSTMENT_FRAG } from './shaders/adjustment'
import { temperatureToMatrix } from './whiteBalance'
import type { EditParams } from '../types'

export interface HistogramData {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  luma: Uint32Array
}

interface ProgramInfo {
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
  vao: WebGLVertexArrayObject
}

// Passthrough shader for blitting FBO texture to canvas
const BLIT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_texture;
void main() {
  fragColor = texture(u_texture, v_uv);
}
`

export class WebGLRenderer {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement

  private geometryProgram!: ProgramInfo
  private adjustmentProgram!: ProgramInfo
  private blitProgram!: ProgramInfo

  private sourceTexture: WebGLTexture | null = null
  private previewTexture: WebGLTexture | null = null
  private geometryFBO: { fbo: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null
  private adjustmentFBO: { fbo: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null

  private fullWidth = 0
  private fullHeight = 0
  private previewWidth = 0
  private previewHeight = 0
  private previewScale = 0.25

  private currentParams: EditParams | null = null
  private rafHandle = 0
  private _cropMode = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 not available')
    this.gl = gl

    const ext = gl.getExtension('EXT_color_buffer_float')
    if (!ext) throw new Error('EXT_color_buffer_float not available')
    gl.getExtension('OES_texture_float_linear')

    this.initPrograms()
    this.initQuadGeometry()
  }

  private initPrograms(): void {
    const geometryUniforms = ['u_texture', 'u_cropRect', 'u_rotation', 'u_flip', 'u_quarterTurns', 'u_srcAspect']
    this.geometryProgram = this.buildProgram(GEOMETRY_VERT, GEOMETRY_FRAG, geometryUniforms)

    const adjustmentUniforms = [
      'u_texture', 'u_exposure', 'u_wbMatrix', 'u_contrast',
      'u_highlights', 'u_shadows', 'u_whites', 'u_blacks',
      'u_clarity', 'u_vibrance', 'u_saturation',
    ]
    this.adjustmentProgram = this.buildProgram(ADJUSTMENT_VERT, ADJUSTMENT_FRAG, adjustmentUniforms)

    this.blitProgram = this.buildProgram(ADJUSTMENT_VERT, BLIT_FRAG, ['u_texture'])
  }

  private buildProgram(vert: string, frag: string, uniformNames: string[]): ProgramInfo {
    const gl = this.gl
    const program = createProgram(
      gl,
      compileShader(gl, gl.VERTEX_SHADER, vert),
      compileShader(gl, gl.FRAGMENT_SHADER, frag),
    )
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    for (const name of uniformNames) {
      uniforms.set(name, gl.getUniformLocation(program, name))
    }
    const vao = gl.createVertexArray()!
    return { program, uniforms, vao }
  }

  private initQuadGeometry(): void {
    const gl = this.gl
    const quadData = new Float32Array([
      -1, -1,  0, 0,
       1, -1,  1, 0,
      -1,  1,  0, 1,
       1,  1,  1, 1,
    ])
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW)

    for (const info of [this.geometryProgram, this.adjustmentProgram, this.blitProgram]) {
      gl.bindVertexArray(info.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)
    }
    gl.bindVertexArray(null)
  }

  loadImage(pixels: Float32Array, width: number, height: number): void {
    const gl = this.gl

    if (this.sourceTexture) gl.deleteTexture(this.sourceTexture)
    if (this.previewTexture) gl.deleteTexture(this.previewTexture)

    this.fullWidth = width
    this.fullHeight = height
    this.previewWidth = Math.max(1, Math.round(width * this.previewScale))
    this.previewHeight = Math.max(1, Math.round(height * this.previewScale))

    // Convert RGB to RGBA for texture upload
    const rgba = new Float32Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = pixels[i * 3]
      rgba[i * 4 + 1] = pixels[i * 3 + 1]
      rgba[i * 4 + 2] = pixels[i * 3 + 2]
      rgba[i * 4 + 3] = 1.0
    }

    this.sourceTexture = createTexture(gl, rgba, width, height, 4)

    // Generate preview by downsampling via FBO blit
    this.previewTexture = this.downsampleTexture(this.sourceTexture, width, height, this.previewWidth, this.previewHeight)

    this.allocateWorkFBOs(this.previewWidth, this.previewHeight)
  }

  private downsampleTexture(
    src: WebGLTexture, _srcW: number, _srcH: number, dstW: number, dstH: number,
  ): WebGLTexture {
    const gl = this.gl
    const dst = createTexture(gl, null, dstW, dstH, 4)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0)

    gl.viewport(0, 0, dstW, dstH)
    gl.useProgram(this.blitProgram.program)
    gl.bindVertexArray(this.blitProgram.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src)
    gl.uniform1i(this.blitProgram.uniforms.get('u_texture')!, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    return dst
  }

  private allocateWorkFBOs(w: number, h: number): void {
    const gl = this.gl
    if (this.geometryFBO) {
      gl.deleteFramebuffer(this.geometryFBO.fbo)
      gl.deleteTexture(this.geometryFBO.texture)
    }
    if (this.adjustmentFBO) {
      gl.deleteFramebuffer(this.adjustmentFBO.fbo)
      gl.deleteTexture(this.adjustmentFBO.texture)
    }
    this.geometryFBO = createFramebuffer(gl, w, h)
    this.adjustmentFBO = createFramebuffer(gl, w, h)
  }

  setParams(params: EditParams): void {
    this.currentParams = params
    this.scheduleRender()
  }

  set cropMode(v: boolean) {
    this._cropMode = v
    this.scheduleRender()
  }

  private scheduleRender(): void {
    if (this.rafHandle) return
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0
      this.renderPreview()
    })
  }

  private renderPreview(): void {
    if (!this.previewTexture || !this.currentParams) return
    const qt = this.currentParams.crop.quarterTurns ?? 0
    const pw = qt % 2 === 1 ? this.previewHeight : this.previewWidth
    const ph = qt % 2 === 1 ? this.previewWidth : this.previewHeight
    this.renderPipeline(this.previewTexture, pw, ph, this.currentParams)
  }

  private renderPipeline(srcTex: WebGLTexture, w: number, h: number, params: EditParams): void {
    const gl = this.gl

    // Ensure FBOs match dimensions
    if (!this.geometryFBO || this.geometryFBO.width !== w || this.geometryFBO.height !== h) {
      this.allocateWorkFBOs(w, h)
    }

    // Pass 1: Geometry
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.geometryFBO!.fbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.geometryProgram.program)
    gl.bindVertexArray(this.geometryProgram.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(this.geometryProgram.uniforms.get('u_texture')!, 0)

    // In crop mode, show the full image so the user can see and position the crop overlay.
    // Outside crop mode (and during export), apply the actual crop.
    const applyCrop = !this._cropMode
    gl.uniform4f(
      this.geometryProgram.uniforms.get('u_cropRect')!,
      applyCrop ? params.crop.x : 0,
      applyCrop ? params.crop.y : 0,
      applyCrop ? params.crop.width : 1,
      applyCrop ? params.crop.height : 1,
    )
    gl.uniform1f(
      this.geometryProgram.uniforms.get('u_rotation')!,
      params.crop.angle * Math.PI / 180,
    )
    gl.uniform2f(this.geometryProgram.uniforms.get('u_flip')!, 0, 0)
    gl.uniform1i(
      this.geometryProgram.uniforms.get('u_quarterTurns')!,
      params.crop.quarterTurns ?? 0,
    )
    const aspect = this.fullWidth / this.fullHeight
    gl.uniform2f(
      this.geometryProgram.uniforms.get('u_srcAspect')!,
      aspect,
      1.0 / aspect,
    )
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Pass 2: Adjustments
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.adjustmentFBO!.fbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.adjustmentProgram.program)
    gl.bindVertexArray(this.adjustmentProgram.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.geometryFBO!.texture)
    gl.uniform1i(this.adjustmentProgram.uniforms.get('u_texture')!, 0)

    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_exposure')!, params.exposure)

    const wbMatrix = temperatureToMatrix(params.temperature, params.tint)
    gl.uniformMatrix3fv(this.adjustmentProgram.uniforms.get('u_wbMatrix')!, false, wbMatrix)

    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_contrast')!, params.contrast / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_highlights')!, params.highlights / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_shadows')!, params.shadows / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_whites')!, params.whites / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_blacks')!, params.blacks / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_clarity')!, params.clarity / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_vibrance')!, params.vibrance / 100)
    gl.uniform1f(this.adjustmentProgram.uniforms.get('u_saturation')!, params.saturation / 100)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Draw to canvas via quad (blitFramebuffer float→RGBA8 is not cross-browser)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.useProgram(this.blitProgram.program)
    gl.bindVertexArray(this.blitProgram.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.adjustmentFBO!.texture)
    gl.uniform1i(this.blitProgram.uniforms.get('u_texture')!, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  getHistogram(): HistogramData {
    const gl = this.gl
    if (!this.adjustmentFBO) {
      return { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) }
    }

    const w = this.adjustmentFBO.width
    const h = this.adjustmentFBO.height
    const pixels = new Float32Array(w * h * 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.adjustmentFBO.fbo)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const r = new Uint32Array(256)
    const g = new Uint32Array(256)
    const b = new Uint32Array(256)
    const luma = new Uint32Array(256)
    const count = w * h

    for (let i = 0; i < count; i++) {
      const ri = Math.min(255, Math.max(0, Math.floor(pixels[i * 4] * 255)))
      const gi = Math.min(255, Math.max(0, Math.floor(pixels[i * 4 + 1] * 255)))
      const bi = Math.min(255, Math.max(0, Math.floor(pixels[i * 4 + 2] * 255)))
      const li = Math.min(255, Math.max(0, Math.floor(0.2126 * ri + 0.7152 * gi + 0.0722 * bi)))
      r[ri]++
      g[gi]++
      b[bi]++
      luma[li]++
    }

    return { r, g, b, luma }
  }

  exportFullRes(params: EditParams): { pixels: Float32Array; width: number; height: number } {
    const gl = this.gl
    if (!this.sourceTexture) throw new Error('No image loaded')

    const w = this.fullWidth
    const h = this.fullHeight
    const qt = params.crop.quarterTurns ?? 0
    const outW = qt % 2 === 1 ? h : w
    const outH = qt % 2 === 1 ? w : h

    // Allocate full-res FBOs temporarily at output dimensions
    const geoFBO = createFramebuffer(gl, outW, outH)
    const adjFBO = createFramebuffer(gl, outW, outH)

    // Save current FBOs
    const prevGeo = this.geometryFBO
    const prevAdj = this.adjustmentFBO
    this.geometryFBO = geoFBO
    this.adjustmentFBO = adjFBO

    this.renderPipeline(this.sourceTexture, outW, outH, params)

    // Readback
    const pixels = new Float32Array(outW * outH * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, adjFBO.fbo)
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.FLOAT, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Cleanup
    gl.deleteFramebuffer(geoFBO.fbo)
    gl.deleteTexture(geoFBO.texture)
    gl.deleteFramebuffer(adjFBO.fbo)
    gl.deleteTexture(adjFBO.texture)

    // Restore
    this.geometryFBO = prevGeo
    this.adjustmentFBO = prevAdj

    // Convert RGBA to RGB and flip vertically
    const rgb = new Float32Array(outW * outH * 3)
    for (let row = 0; row < outH; row++) {
      const srcRow = outH - 1 - row
      for (let col = 0; col < outW; col++) {
        const si = (srcRow * outW + col) * 4
        const di = (row * outW + col) * 3
        rgb[di] = pixels[si]
        rgb[di + 1] = pixels[si + 1]
        rgb[di + 2] = pixels[si + 2]
      }
    }

    return { pixels: rgb, width: outW, height: outH }
  }

  getEffectiveDims(quarterTurns: number): { w: number; h: number } {
    if (quarterTurns % 2 === 1) {
      return { w: this.fullHeight, h: this.fullWidth }
    }
    return { w: this.fullWidth, h: this.fullHeight }
  }

  resize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
    if (this.currentParams) this.scheduleRender()
  }

  dispose(): void {
    const gl = this.gl
    cancelAnimationFrame(this.rafHandle)
    if (this.sourceTexture) gl.deleteTexture(this.sourceTexture)
    if (this.previewTexture) gl.deleteTexture(this.previewTexture)
    if (this.geometryFBO) {
      gl.deleteFramebuffer(this.geometryFBO.fbo)
      gl.deleteTexture(this.geometryFBO.texture)
    }
    if (this.adjustmentFBO) {
      gl.deleteFramebuffer(this.adjustmentFBO.fbo)
      gl.deleteTexture(this.adjustmentFBO.texture)
    }
    gl.deleteProgram(this.geometryProgram.program)
    gl.deleteProgram(this.adjustmentProgram.program)
    gl.deleteProgram(this.blitProgram.program)
  }
}
