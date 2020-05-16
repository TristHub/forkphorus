/// <reference path="../phosphorus.ts" />
/// <reference path="renderer.ts" />
/// <reference path="matrix.ts" />

namespace P.renderer.webgl {
  import RotationStyle = P.core.RotationStyle;

  function createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 360;
    return canvas;
  }

  function filtersAffectShape(filters: P.core.Filters): boolean {
    return filters.fisheye !== 0 ||
      filters.mosaic !== 0 ||
      filters.pixelate !== 0 ||
      filters.whirl !== 0;
  }

  const horizontalInvertMatrix = P.m3.scaling(-1, 1);

  class Shader {
    protected uniformLocations: { [name: string]: WebGLUniformLocation } = {};
    protected attributeLocations: { [name: string]: number } = {};

    constructor(public gl: WebGLRenderingContext, public program: WebGLProgram) {
      // When loaded we'll lookup all of our attributes and uniforms, and store
      // their locations locally.
      // WebGL can tell us how many there are, so we can do lookups.

      const activeUniforms: number = gl.getProgramParameter(program, this.gl.ACTIVE_UNIFORMS);
      for (let index = 0; index < activeUniforms; index++) {
        const info = gl.getActiveUniform(program, index);
        if (!info) {
          throw new Error('uniform at index ' + index + ' does not exist');
        }
        const name = info.name;
        const location = gl.getUniformLocation(program, name);
        if (!location) {
          throw new Error('uniform named ' + name + ' does not exist');
        }
        this.uniformLocations[name] = location;
      }

      const activeAttributes: number = gl.getProgramParameter(program, this.gl.ACTIVE_ATTRIBUTES);
      for (let index = 0; index < activeAttributes; index++) {
        const info = gl.getActiveAttrib(program, index);
        if (!info) {
          throw new Error('attribute at index ' + index + ' does not exist');
        }
        // Attribute index is location, I believe.
        this.attributeLocations[info.name] = index;
      }
    }

    /**
     * Sets a uniform to a float
     * @param name The name of the uniform
     * @param value A float
     */
    uniform1f(name: string, value: number) {
      const location = this.getUniform(name);
      this.gl.uniform1f(location, value);
    }

    /**
     * Sets a uniform to a vec2
     * @param name The name of the uniform
     * @param a The first value
     * @param b The second value
     */
    uniform2f(name: string, a: number, b: number) {
      const location = this.getUniform(name);
      this.gl.uniform2f(location, a, b);
    }

    /**
     * Sets a uniform to a vec4
     * @param name The name of the uniform
     * @param a The first value
     * @param b The second value
     */
    uniform4f(name: string, a: number, b: number, c: number, d: number) {
      const location = this.getUniform(name);
      this.gl.uniform4f(location, a, b, c, d);
    }

    /**
     * Sets a uniform to a 3x3 matrix
     * @param name The name of the uniform
     * @param value The 3x3 matrix
     */
    uniformMatrix3(name: string, value: P.m3.Matrix3) {
      const location = this.getUniform(name);
      this.gl.uniformMatrix3fv(location, false, value);
    }

    /**
     * Determines if this shader variant contains a uniform.
     * @param name The name of the uniform
     */
    hasUniform(name: string) {
      return this.uniformLocations.hasOwnProperty(name);
    }

    /**
     * Determines the location of a uniform, or errors if it does not exist.
     * @param name The name of the uniform
     */
    getUniform(name: string): WebGLUniformLocation {
      if (!this.hasUniform(name)) {
        throw new Error('uniform of name ' + name + ' does not exist');
      }
      return this.uniformLocations[name];
    }

    /**
     * Binds a buffer to an attribute
     * @param name The name of the attribute
     * @param value The WebGL buffer to bind
     */
    attributeBuffer(name: string, value: WebGLBuffer) {
      if (!this.hasAttribute(name)) {
        throw new Error('attribute of name ' + name + ' does not exist');
      }
      const location = this.attributeLocations[name];
      this.gl.enableVertexAttribArray(location);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, value);
      this.gl.vertexAttribPointer(location, 2, this.gl.FLOAT, false, 0, 0);
    }

    /**
     * Determines if this shader contains an attribute
     * @param name The name of the attribute
     */
    hasAttribute(name: string) {
      return this.attributeLocations.hasOwnProperty(name);
    }

    /**
     * Determines the location of an attribute, and errors if it does not exist.
     * @param name The name of the attribute
     */
    getAttribute(name: string) {
      if (!this.hasAttribute(name)) {
        throw new Error('attribute of name ' + name + ' does not exist');
      }
      return this.attributeLocations[name];
    }
  }

  class WebGLSpriteRenderer {
    public static vertexShader: string = `
    attribute vec2 a_position;

    uniform mat3 u_matrix;

    varying vec2 v_texcoord;

    void main() {
      gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
      v_texcoord = a_position;
    }
    `;

    public static fragmentShader: string = `
    precision mediump float;

    varying vec2 v_texcoord;

    uniform sampler2D u_texture;

    #ifdef ENABLE_BRIGHTNESS
      uniform float u_brightness;
    #endif
    #ifdef ENABLE_COLOR
      uniform float u_color;
    #endif
    #ifdef ENABLE_GHOST
      uniform float u_opacity;
    #endif
    #ifdef ENABLE_MOSAIC
      uniform float u_mosaic;
    #endif
    #ifdef ENABLE_WHIRL
      uniform float u_whirl;
    #endif
    #ifdef ENABLE_FISHEYE
      uniform float u_fisheye;
    #endif
    #ifdef ENABLE_PIXELATE
      uniform float u_pixelate;
      uniform vec2 u_size;
    #endif

    const float minimumAlpha = 1.0 / 250.0;
    const vec2 vecCenter = vec2(0.5, 0.5);

    // http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl
    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = c.g < c.b ? vec4(c.bg, K.wz) : vec4(c.gb, K.xy);
      vec4 q = c.r < p.x ? vec4(p.xyw, c.r) : vec4(c.r, p.yzx);
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      // varyings cannot be modified
      vec2 texcoord = v_texcoord;

      #ifdef ENABLE_MOSAIC
        texcoord = fract(u_mosaic * v_texcoord);
      #endif

      #ifdef ENABLE_PIXELATE
      if (u_pixelate != 0.0) {
        vec2 texelSize = u_size / u_pixelate;
        texcoord = (floor(texcoord * texelSize) + vecCenter) / texelSize;
      }
      #endif

      #ifdef ENABLE_WHIRL
      {
        const float radius = 0.5;
        vec2 offset = texcoord - vecCenter;
        float offsetMagnitude = length(offset);
        float whirlFactor = max(1.0 - (offsetMagnitude / radius), 0.0);
        float whirlActual = u_whirl * whirlFactor * whirlFactor;
        float sinWhirl = sin(whirlActual);
        float cosWhirl = cos(whirlActual);
        mat2 rotationMatrix = mat2(
          cosWhirl, -sinWhirl,
          sinWhirl, cosWhirl
        );
        texcoord = rotationMatrix * offset + vecCenter;
      }
      #endif

      #ifdef ENABLE_FISHEYE
      {
        vec2 vec = (texcoord - vecCenter) / vecCenter;
        float vecLength = length(vec);
        float r = pow(min(vecLength, 1.0), u_fisheye) * max(1.0, vecLength);
        vec2 unit = vec / vecLength;
        texcoord = vecCenter + r * unit * vecCenter;
      }
      #endif

      vec4 color = texture2D(u_texture, texcoord);
      if (color.a < minimumAlpha) {
        discard;
      }

      #ifdef ENABLE_GHOST
        color.a *= u_opacity;
      #endif

      #ifdef ENABLE_COLOR
      if (u_color != 0.0) {
        vec3 hsv = rgb2hsv(color.rgb);
        // hsv.x = hue
        // hsv.y = saturation
        // hsv.z = value

        // scratch forces all colors to have some minimal amount saturation so there is a visual change
        const float minValue = 0.11 / 2.0;
        const float minSaturation = 0.09;
        if (hsv.z < minValue) hsv = vec3(0.0, 1.0, minValue);
        else if (hsv.y < minSaturation) hsv = vec3(0.0, minSaturation, hsv.z);

        hsv.x = mod(hsv.x + u_color, 1.0);
        if (hsv.x < 0.0) hsv.x += 1.0;
        color = vec4(hsv2rgb(hsv), color.a);
      }
      #endif

      #ifdef ENABLE_BRIGHTNESS
        color.rgb = clamp(color.rgb + vec3(u_brightness), 0.0, 1.0);
      #endif

      gl_FragColor = color;
    }
    `;

    public canvas: HTMLCanvasElement;
    public gl: WebGLRenderingContext;

    protected quadBuffer: WebGLBuffer;

    protected globalScaleMatrix: P.m3.Matrix3 = P.m3.scaling(1, 1);

    protected allFiltersShader: Shader;
    protected noFiltersShader: Shader;

    private costumeTextures: Map<P.core.Costume, WebGLTexture> = new Map();

    constructor() {
      this.canvas = createCanvas();
      const gl = this.canvas.getContext('webgl', this.getContextOptions());
      if (!gl) {
        throw new Error('cannot get webgl rendering context');
      }
      this.gl = gl;

      this.noFiltersShader = this.compileVariant([]);

      this.allFiltersShader = this.compileVariant([
        'ENABLE_BRIGHTNESS',
        'ENABLE_COLOR',
        'ENABLE_GHOST',
        'ENABLE_FISHEYE',
        'ENABLE_MOSAIC',
        'ENABLE_PIXELATE',
      ]);

      // Enable blending
      this.gl.enable(this.gl.BLEND);
      this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

      this.gl.disable(this.gl.DEPTH_TEST);

      // Create the quad buffer that we'll use for positioning and texture coordinates later.
      this.quadBuffer = this.gl.createBuffer()!;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
        0, 0,
        0, 1,
        1, 0,
        1, 0,
        0, 1,
        1, 1,
      ]), this.gl.STATIC_DRAW);
    }

    protected getContextOptions(): WebGLContextAttributes {
      return {
        alpha: false,
      };
    }

    /**
     * Compile a single shader
     * @param type The type of the shader. Use this.gl.VERTEX_SHADER or FRAGMENT_SHADER
     * @param source The string source of the shader.
     * @param definitions Flags to define in the shader source.
     */
    protected compileShader(type: number, source: string, definitions?: string[]): WebGLShader {
      if (definitions) {
        for (const def of definitions) {
          source = '#define ' + def + '\n' + source;
        }
      }

      const shader = this.gl.createShader(type);
      if (!shader) {
        throw new Error('Cannot create shader');
      }

      this.gl.shaderSource(shader, source);
      this.gl.compileShader(shader);

      if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
        const error = this.gl.getShaderInfoLog(shader);
        this.gl.deleteShader(shader);
        throw new Error('Shader compilation error: ' + error);
      }

      return shader;
    }

    /**
     * Compiles a vertex shader and fragment shader into a program.
     * @param vs Vertex shader source.
     * @param fs Fragment shader source.
     * @param definitions Things to define in the source of both shaders.
     */
    protected compileProgram(vs: string, fs: string, definitions?: string[]): WebGLProgram {
      const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vs, definitions);
      const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fs, definitions);

      const program = this.gl.createProgram();
      if (!program) {
        throw new Error('Cannot create program');
      }
      this.gl.attachShader(program, vertexShader);
      this.gl.attachShader(program, fragmentShader);
      this.gl.linkProgram(program);

      if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
        const error = this.gl.getProgramInfoLog(program);
        this.gl.deleteProgram(program);
        throw new Error('Program compilation error: ' + error);
      }

      return program;
    }

    /**
     * Compiles a variant of the default shader.
     * @param definitions Things to define in the shader
     */
    protected compileVariant(definitions: string[]): Shader {
      const program = this.compileProgram(WebGLSpriteRenderer.vertexShader, WebGLSpriteRenderer.fragmentShader, definitions);
      return new Shader(this.gl, program);
    }

    /**
     * Creates a new texture without inserting data.
     * Texture will be bound to TEXTURE_2D, so you can texImage2D() on it
     */
    protected createTexture(): WebGLTexture {
      const texture = this.gl.createTexture();
      if (!texture) {
        throw new Error('Cannot create texture');
      }
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);

      return texture;
    }

    /**
     * Converts a canvas to a WebGL texture
     * @param canvas The source canvas. Dimensions do not matter.
     */
    protected convertToTexture(canvas: HTMLImageElement | HTMLCanvasElement): WebGLTexture {
      const texture = this.createTexture();
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, canvas);
      return texture;
    }

    /**
     * Creates a new framebuffer
     */
    protected createFramebuffer(): WebGLFramebuffer {
      const frameBuffer = this.gl.createFramebuffer();
      if (!frameBuffer) {
        throw new Error('cannot create frame buffer');
      }
      return frameBuffer;
    }

    /**
     * Reset and resize this renderer.
     */
    reset(scale: number) {
      this.canvas.width = scale * 480;
      this.canvas.height = scale * 360;
      this.resetFramebuffer(scale);
    }

    /**
     * Resizes and resets the current framebuffer
     * @param scale Zoom level
     */
    protected resetFramebuffer(scale: number) {
      this.gl.viewport(0, 0, scale * 480, scale * 360);
      // the first element of the matrix is the x-scale, so we can use that to only recreate the matrix when needed
      if (this.globalScaleMatrix[0] !== scale) {
        this.globalScaleMatrix = P.m3.scaling(scale, scale);
      }

      // Clear the canvas
      this.gl.clearColor(1, 1, 1, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    drawChild(child: P.core.Base) {
      this._drawChild(child, this.allFiltersShader);
    }

    /**
     * Real implementation of drawChild()
     * @param child The child to draw
     */
    protected _drawChild(child: P.core.Base, shader: Shader) {
      this.gl.useProgram(shader.program);

      // Create the texture if it doesn't already exist.
      const costume = child.costumes[child.currentCostumeIndex];
      if (!this.costumeTextures.has(costume)) {
        const image = costume.getImage();
        const texture = this.convertToTexture(image);
        this.costumeTextures.set(costume, texture);
      }
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.costumeTextures.get(costume)!);

      shader.attributeBuffer('a_position', this.quadBuffer);

      // TODO: optimize
      const matrix = P.m3.projection(this.canvas.width, this.canvas.height);
      P.m3.multiply(matrix, this.globalScaleMatrix);
      P.m3.multiply(matrix, P.m3.translation(240 + child.scratchX | 0, 180 - child.scratchY | 0));
      if (P.core.isSprite(child)) {
        if (child.rotationStyle === RotationStyle.Normal && child.direction !== 90) {
          P.m3.multiply(matrix, P.m3.rotation(90 - child.direction));
        } else if (child.rotationStyle === RotationStyle.LeftRight && child.direction < 0) {
          P.m3.multiply(matrix, horizontalInvertMatrix);
        }
        if (child.scale !== 1) {
          P.m3.multiply(matrix, P.m3.scaling(child.scale, child.scale));
        }
      }
      if (costume.scale !== 1) {
        P.m3.multiply(matrix, P.m3.scaling(costume.scale, costume.scale));
      }
      P.m3.multiply(matrix, P.m3.translation(-costume.rotationCenterX, -costume.rotationCenterY));
      P.m3.multiply(matrix, P.m3.scaling(costume.width, costume.height));

      shader.uniformMatrix3('u_matrix', matrix);

      // Effects
      if (shader.hasUniform('u_opacity')) {
        shader.uniform1f('u_opacity', 1 - child.filters.ghost / 100);
      }
      if (shader.hasUniform('u_brightness')) {
        shader.uniform1f('u_brightness', child.filters.brightness / 100);
      }
      if (shader.hasUniform('u_color')) {
        shader.uniform1f('u_color', child.filters.color / 200);
      }
      if (shader.hasUniform('u_mosaic')) {
        const mosaic = Math.round((Math.abs(child.filters.mosaic) + 10) / 10);
        shader.uniform1f('u_mosaic', P.utils.clamp(mosaic, 1, 512));
      }
      if (shader.hasUniform('u_whirl')) {
        shader.uniform1f('u_whirl', child.filters.whirl * Math.PI / -180);
      }
      if (shader.hasUniform('u_fisheye')) {
        shader.uniform1f('u_fisheye', Math.max(0, (child.filters.fisheye + 100) / 100));
      }
      if (shader.hasUniform('u_pixelate')) {
        shader.uniform1f('u_pixelate', Math.abs(child.filters.pixelate) / 10);
      }
      if (shader.hasUniform('u_size')) {
        shader.uniform2f('u_size', costume.width, costume.height);
      }

      this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    /**
     * Draw a texture covering the entire screen
     * @param texture The texture to draw. Must belong to this renderer.
     */
    protected drawTextureOverlay(texture: WebGLTexture) {
      const shader = this.noFiltersShader;
      this.gl.useProgram(shader.program);

      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

      shader.attributeBuffer('a_position', this.quadBuffer);

      const matrix = P.m3.projection(this.canvas.width, this.canvas.height);
      P.m3.multiply(matrix, this.globalScaleMatrix);
      P.m3.multiply(matrix, P.m3.translation(240, 180));
      P.m3.multiply(matrix, P.m3.scaling(1, 1));
      P.m3.multiply(matrix, P.m3.translation(-240, -180));
      P.m3.multiply(matrix, P.m3.scaling(480, 360));

      shader.uniformMatrix3('u_matrix', matrix);

      this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }
  }

  class CollisionRenderer extends WebGLSpriteRenderer {
    private static touchingVertex = `
    attribute vec2 a_position;

    uniform mat3 u_matrix;

    varying vec2 v_texcoord;

    void main() {
      gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
      v_texcoord = a_position;
    }`;

    private static touchingFragment = `
    precision mediump float;

    varying vec2 v_texcoord;

    uniform sampler2D u_texture;

    #ifdef ENABLE_BRIGHTNESS
      uniform float u_brightness;
    #endif
    #ifdef ENABLE_COLOR
      uniform float u_color;
    #endif
    #ifdef ENABLE_GHOST
      uniform float u_opacity;
    #endif
    #ifdef ENABLE_MOSAIC
      uniform float u_mosaic;
    #endif
    #ifdef ENABLE_WHIRL
      uniform float u_whirl;
    #endif
    #ifdef ENABLE_FISHEYE
      uniform float u_fisheye;
    #endif
    #ifdef ENABLE_PIXELATE
      uniform float u_pixelate;
      uniform vec2 u_size;
    #endif

    const float minimumAlpha = 1.0 / 250.0;
    const vec2 vecCenter = vec2(0.5, 0.5);

    // http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl
    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = c.g < c.b ? vec4(c.bg, K.wz) : vec4(c.gb, K.xy);
      vec4 q = c.r < p.x ? vec4(p.xyw, c.r) : vec4(c.r, p.yzx);
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      // varyings cannot be modified
      vec2 texcoord = v_texcoord;

      #ifdef ENABLE_MOSAIC
        texcoord = fract(u_mosaic * v_texcoord);
      #endif

      #ifdef ENABLE_PIXELATE
      if (u_pixelate != 0.0) {
        vec2 texelSize = u_size / u_pixelate;
        texcoord = (floor(texcoord * texelSize) + vecCenter) / texelSize;
      }
      #endif

      #ifdef ENABLE_WHIRL
      {
        const float radius = 0.5;
        vec2 offset = texcoord - vecCenter;
        float offsetMagnitude = length(offset);
        float whirlFactor = max(1.0 - (offsetMagnitude / radius), 0.0);
        float whirlActual = u_whirl * whirlFactor * whirlFactor;
        float sinWhirl = sin(whirlActual);
        float cosWhirl = cos(whirlActual);
        mat2 rotationMatrix = mat2(
          cosWhirl, -sinWhirl,
          sinWhirl, cosWhirl
        );
        texcoord = rotationMatrix * offset + vecCenter;
      }
      #endif

      #ifdef ENABLE_FISHEYE
      {
        vec2 vec = (texcoord - vecCenter) / vecCenter;
        float vecLength = length(vec);
        float r = pow(min(vecLength, 1.0), u_fisheye) * max(1.0, vecLength);
        vec2 unit = vec / vecLength;
        texcoord = vecCenter + r * unit * vecCenter;
      }
      #endif

      vec4 color = texture2D(u_texture, texcoord);
      // if (color.a < minimumAlpha) {
      //   discard;
      // }

      #ifdef ENABLE_GHOST
        color.a *= u_opacity;
      #endif

      #ifdef ENABLE_COLOR
      if (u_color != 0.0) {
        vec3 hsv = rgb2hsv(color.rgb);
        // hsv.x = hue
        // hsv.y = saturation
        // hsv.z = value

        // scratch forces all colors to have some minimal amount saturation so there is a visual change
        const float minValue = 0.11 / 2.0;
        const float minSaturation = 0.09;
        if (hsv.z < minValue) hsv = vec3(0.0, 1.0, minValue);
        else if (hsv.y < minSaturation) hsv = vec3(0.0, minSaturation, hsv.z);

        hsv.x = mod(hsv.x + u_color, 1.0);
        if (hsv.x < 0.0) hsv.x += 1.0;
        color = vec4(hsv2rgb(hsv), color.a);
      }
      #endif

      #ifdef ENABLE_BRIGHTNESS
        color.rgb = clamp(color.rgb + vec3(u_brightness), 0.0, 1.0);
      #endif

      if (color.a > 0.0) {
        color = vec4(1.0, 1.0, 1.0, 1.0);
      } else {
        color = vec4(0.0, 0.0, 0.0, 0.0);
      }

      gl_FragColor = color;
    }
    `;

    private touchingShader: Shader;

    constructor() {
      super();

      this.gl.enable(this.gl.SCISSOR_TEST);
      this.gl.scissor(0, 0, 480, 360);

      this.touchingShader = new Shader(this.gl, this.compileProgram(CollisionRenderer.touchingVertex, CollisionRenderer.touchingFragment));
    }

    drawChild(sprite: P.core.Base) {
      this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
      super.drawChild(sprite);
    }

    drawChildTouching(sprite: P.core.Base) {
      this.gl.blendFunc(this.gl.DST_ALPHA, this.gl.ZERO);
      this._drawChild(sprite, this.touchingShader);
    }
  }

  class PenRenderer extends WebGLSpriteRenderer {
    static PEN_VERTEX_SHADER = `
    precision mediump float;

    // [0] = x1
    // [1] = y1
    // [2] = x2
    // [3] = y2
    attribute vec4 vertexData;
    // [0] = thickened vertex direction
    // [1] = thickened vertex distance
    attribute vec2 lineData;
    // [0] = red
    // [1] = green
    // [2] = blue
    // [3] = alpha
    attribute vec4 colorData;

    varying vec4 fragColor;

    void main(){

      vec2 lineDir = normalize(vertexData.zw - vertexData.xy);

      mat2 rot;
      rot[0] = vec2(cos(lineData.x), sin(lineData.x));
      rot[1] = vec2(-sin(lineData.x), cos(lineData.x));

      lineDir *= rot * lineData.y;

      vec2 p = (vertexData.xy + lineDir);
      p.x /= 240.0;
      p.y /= 180.0;

      gl_Position = vec4(p, 0.0, 1.0);
      fragColor = colorData;
    }
    `;

    static PEN_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 fragColor;
    void main(){

      gl_FragColor = vec4(fragColor.xyz / 255.0, fragColor.w);
    }
    `;

    public dirty: boolean = false;

    private penCoords: Float32Array = new Float32Array(65536);
    private penLines: Float32Array = new Float32Array(32768);
    private penColors: Float32Array = new Float32Array(65536);
    private penCoordsIndex: number = 0;
    private penLinesIndex: number = 0;
    private penColorsIndex: number = 0;

    private positionBuffer: WebGLBuffer;
    private lineBuffer: WebGLBuffer;
    private colorBuffer: WebGLBuffer;

    private shader: Shader;

    constructor() {
      super();

      this.shader = new Shader(this.gl, this.compileProgram(PenRenderer.PEN_VERTEX_SHADER, PenRenderer.PEN_FRAGMENT_SHADER));

      this.positionBuffer = this.gl.createBuffer()!;
      this.lineBuffer = this.gl.createBuffer()!;
      this.colorBuffer = this.gl.createBuffer()!;

      this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
      this.gl.enable(this.gl.BLEND);
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    protected getContextOptions(): WebGLContextAttributes {
      return {
        alpha: true,
        preserveDrawingBuffer: true,
      };
    }

    pendingPenOperations() {
      return this.penLinesIndex > 0;
    }

    drawPen() {
      const gl = this.gl;
      this.dirty = true;

      // Upload position data
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.penCoords, gl.STREAM_DRAW);
      gl.vertexAttribPointer(this.shader.getAttribute('vertexData'), 4, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this.shader.getAttribute('vertexData'));

      // Upload line info data
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.penLines, gl.STREAM_DRAW);
      gl.vertexAttribPointer(this.shader.getAttribute('lineData'), 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this.shader.getAttribute('lineData'));

      // Upload color data
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.penColors, gl.STREAM_DRAW);
      gl.vertexAttribPointer(this.shader.getAttribute('colorData'), 4, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this.shader.getAttribute('colorData'));

      gl.useProgram(this.shader.program);
      gl.drawArrays(gl.TRIANGLES, 0, (this.penCoordsIndex + 1) / 4);

      this.penCoordsIndex = 0;
      this.penLinesIndex = 0;
      this.penColorsIndex = 0;
    }

    private buffersFull(size: number) {
      return this.penCoordsIndex + size > this.penCoords.length;
    }

    private getCircleResolution(size: number) {
      return Math.max(Math.ceil(size), 3);
    }

    penLine(color: P.core.PenColor, size: number, x1: number, y1: number, x2: number, y2: number): void {
      const circleRes = this.getCircleResolution(size);

      // Redraw when array is full.
      if (this.buffersFull(24 * (circleRes + 1))) {
        this.drawPen();
      }

      // draw line
      // first triangle
      // first coordinates
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // first coordinates supplement
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      // first vertex description
      this.penLines[this.penLinesIndex] = -Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      // second coordinates
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      // second coordinates supplement
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // second vertex description
      this.penLines[this.penLinesIndex] = Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      // third coordinates
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // third coordinates supplement
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      // second vertex description
      this.penLines[this.penLinesIndex] = Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      // second triangle
      // first coordinates
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // first coordinates supplement
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      //first vertex description
      this.penLines[this.penLinesIndex] = Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      // second coordinates
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      // second coordinates supplement
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // second vertex description
      this.penLines[this.penLinesIndex] = -Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      // third coordinates
      this.penCoords[this.penCoordsIndex] = x2;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y2;
      this.penCoordsIndex++;

      // third coordinates supplement
      this.penCoords[this.penCoordsIndex] = x1;
      this.penCoordsIndex++;
      this.penCoords[this.penCoordsIndex] = y1;
      this.penCoordsIndex++;

      // second vertex description
      this.penLines[this.penLinesIndex] = Math.PI / 2;
      this.penLinesIndex++;
      this.penLines[this.penLinesIndex] = size / 2;
      this.penLinesIndex++;

      for (var i = 0; i < circleRes; i++) {
        // first endcap
        // first coordinates
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // first coordinates supplement
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // first vertex description
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;

        // second coordinates
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // second coordinates supplement
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // second vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + i / circleRes * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;

        // third coordinates
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // third coordinates supplement
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // third vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + (i + 1) / circleRes * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;

        // second endcap
        // first coordinates
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // first coordinates supplement
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // first vertex description
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;

        // second coordinates
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // second coordinates supplement
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // second vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + i / circleRes * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;

        // third coordinates
        this.penCoords[this.penCoordsIndex] = x1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y1;
        this.penCoordsIndex++;

        // third coordinates supplement
        this.penCoords[this.penCoordsIndex] = x2;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y2;
        this.penCoordsIndex++;

        // third vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + (i + 1) / circleRes * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;
      }

      const [r, g, b, a] = color.toParts();

      // set color of vertices
      for (var i = 0; i < circleRes * 6 + 6; i++) {
        this.penColors[this.penColorsIndex] = r;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = g;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = b;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = a;
        this.penColorsIndex++;
      }
    }

    penDot(color: P.core.PenColor, size: number, x: number, y: number): void {
      const circleRes = this.getCircleResolution(size);

      // Redraw when array is full.
      if (this.buffersFull(12 * circleRes)) {
        this.drawPen();
      }

      for (var i = 0; i < circleRes; i++) {
        // first endcap
        // first coordinates
        this.penCoords[this.penCoordsIndex] = x;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y;
        this.penCoordsIndex++;

        // first coordinates supplement
        this.penCoords[this.penCoordsIndex] = x;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = x;
        this.penCoordsIndex++;

        // first vertex description
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = 0;
        this.penLinesIndex++;

        // second coordinates
        this.penCoords[this.penCoordsIndex] = x;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y;
        this.penCoordsIndex++;

        // second coordinates supplement
        this.penCoords[this.penCoordsIndex] = x + 1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y + 1;
        this.penCoordsIndex++;

        // second vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + i / circleRes * 2 * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;

        // third coordinates
        this.penCoords[this.penCoordsIndex] = x;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y;
        this.penCoordsIndex++;

        // third coordinates supplement
        this.penCoords[this.penCoordsIndex] = x + 1;
        this.penCoordsIndex++;
        this.penCoords[this.penCoordsIndex] = y + 1;
        this.penCoordsIndex++;

        // third vertex description
        this.penLines[this.penLinesIndex] = Math.PI / 2 + (i + 1) / circleRes * 2 * Math.PI;
        this.penLinesIndex++;
        this.penLines[this.penLinesIndex] = size / 2;
        this.penLinesIndex++;
      }

      const [r, g, b, a] = color.toParts();

      // set color of vertices
      for (var i = 0; i < circleRes * 3; i++) {
        this.penColors[this.penColorsIndex] = r;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = g;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = b;
        this.penColorsIndex++;
        this.penColors[this.penColorsIndex] = a;
        this.penColorsIndex++;
      }
    }

    penStamp(sprite: P.core.Sprite): void {
      if (this.penCoordsIndex) {
        this.drawPen();
      }
      this.drawChild(sprite);
    }

    penClear(): void {
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }

  export class WebGLProjectRenderer extends WebGLSpriteRenderer implements ProjectRenderer {
    public penLayer: HTMLCanvasElement;
    public stageLayer: HTMLCanvasElement;
    public zoom: number = 1;

    protected fallbackRenderer: ProjectRenderer;
    protected shaderOnlyShapeFilters = this.compileVariant(['ONLY_SHAPE_FILTERS']);

    private collisionRenderer: CollisionRenderer = new CollisionRenderer();
    private penRenderer: PenRenderer = new PenRenderer();
    private penTexture: WebGLTexture;

    constructor(public stage: P.core.Stage) {
      super();

      this.fallbackRenderer = new P.renderer.canvas2d.ProjectRenderer2D(stage);

      this.reset(1);
    }

    drawFrame() {
      if (this.penRenderer.pendingPenOperations()) {
        this.penRenderer.drawPen();
      }
      this.reset(this.zoom);
      this.drawChild(this.stage);
      if (this.penRenderer.dirty) {
        this.updatePenTexture();
        this.penRenderer.dirty = false;
      }
      if (this.penTexture) {
        this.drawTextureOverlay(this.penTexture);
      }
      for (var i = 0; i < this.stage.children.length; i++) {
        var child = this.stage.children[i];
        if (!child.visible) {
          continue;
        }
        this.drawChild(child);
      }
    }

    init(root: HTMLElement) {
      root.appendChild(this.canvas);
    }

    onStageFiltersChanged() {
      // no-op; we always re-render the stage in full
    }

    penLine(color: P.core.PenColor, size: number, x1: number, y1: number, x2: number, y2: number): void {
      this.penRenderer.penLine(color, size, x1, y1, x2, y2);
    }

    penDot(color: P.core.PenColor, size: number, x: number, y: number): void {
      this.penRenderer.penDot(color, size, x, y);
    }

    penStamp(sprite: P.core.Sprite): void {
      this.penRenderer.penStamp(sprite);
    }

    penClear(): void {
      this.penRenderer.penClear();
    }

    private updatePenTexture() {
      if (this.penTexture) {
        this.gl.deleteTexture(this.penTexture);
      }
      this.penTexture = this.convertToTexture(this.penRenderer.canvas);
    }

    resize(scale: number): void {
      this.zoom = scale;
      // TODO: resize pen layer
    }

    spriteTouchesPoint(sprite: core.Sprite, x: number, y: number): boolean {
      // If filters will not change the shape of the sprite, it would be faster
      // to avoid going to the GPU
      if (!filtersAffectShape(sprite.filters)) {
        return this.fallbackRenderer.spriteTouchesPoint(sprite, x, y);
      }

      this.resetFramebuffer(1);

      this._drawChild(sprite, this.shaderOnlyShapeFilters);

      // Allocate 4 bytes to store 1 RGBA pixel
      const result = new Uint8Array(4);
      // Coordinates are in pixels from the lower left corner
      // We only care about 1 pixel, the pixel at the mouse cursor.
      this.gl.readPixels(240 + x | 0, 180 + y | 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, result);

      // Just look for a non-zero alpha channel
      return result[3] !== 0;
    }

    spritesIntersect(spriteA: core.Sprite, otherSprites: core.Base[]): boolean {
      const mb = spriteA.rotatedBounds();

      for (const spriteB of otherSprites) {
        if (!spriteB.visible || spriteA === spriteB) {
          continue;
        }

        const ob = spriteB.rotatedBounds();
        if (mb.bottom >= ob.top || ob.bottom >= mb.top || mb.left >= ob.right || ob.left >= mb.right) {
          continue;
        }

        const left = Math.max(mb.left, ob.left);
        const top = Math.min(mb.top, ob.top);
        const right = Math.min(mb.right, ob.right);
        const bottom = Math.max(mb.bottom, ob.bottom);

        const width = Math.max(right - left, 1);
        const height = Math.max(top - bottom, 1);

        this.collisionRenderer.gl.scissor(240 + left, 180 + bottom, width, height);
        this.collisionRenderer.gl.clear(this.collisionRenderer.gl.COLOR_BUFFER_BIT);

        this.collisionRenderer.drawChild(spriteA);
        this.collisionRenderer.drawChildTouching(spriteB);

        var data = new Uint8Array(width * height * 4);
        this.collisionRenderer.gl.readPixels(
          240 + left,
          180 + bottom,
          width,
          height,
          this.collisionRenderer.gl.RGBA,
          this.collisionRenderer.gl.UNSIGNED_BYTE,
          data
        );

        this.collisionRenderer.gl.scissor(0, 0, 480, 360);

        var length = data.length;
        for (var j = 0; j < length; j += 4) {
          if (data[j + 3]) {
            return true;
          }
        }
      }

      return false;
    }

    spriteTouchesColor(sprite: core.Base, color: number): boolean {
      return this.fallbackRenderer.spriteTouchesColor(sprite, color);
    }

    spriteColorTouchesColor(sprite: core.Base, spriteColor: number, otherColor: number): boolean {
      return this.fallbackRenderer.spriteColorTouchesColor(sprite, spriteColor, otherColor);
    }
  }
}