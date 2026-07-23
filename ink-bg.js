/*!
 * ink-bg.js — 水墨流体互动背景
 *
 * 全屏 WebGL2 流体模拟（Stable Fluids）：
 *   鼠标/手指注入速度场和墨，涡量约束制造卷曲的墨丝，浮力让墨往上飘。
 *   没有任何外部依赖，一个文件即可。
 *
 * 用法：
 *   <script src="ink-bg.js"></script>
 *   <script>InkBackground.create();</script>
 * 或者自动初始化：
 *   <script src="ink-bg.js" data-auto></script>
 *
 * 参数见下面的 DEFAULTS。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    // ---- 外观 ----
    paper: '#F2F1EC',        // 纸色
    ink: '#1A1916',          // 墨色
    density: 2.2,            // 墨的浓度曲线，越大越黑
    maxInk: 1,               // 墨色上限。做正文背景时压到 0.4~0.6，保证文字始终读得清
    grain: 0.05,             // 纸纹颗粒强度，0 = 关闭
    fiber: 0.035,            // 纸张大尺度纹理（washi 的斑驳感）

    // ---- 流体 ----
    simRes: 128,             // 速度场分辨率（性能主要看这个）
    dyeRes: 1024,            // 墨的分辨率（细节主要看这个）
    velocityDissipation: 0.18,  // 速度衰减，越大越快静止
    dyeDissipation: 0.75,       // 墨的消散速度
    pressureIterations: 22,     // 压力求解迭代次数
    pressure: 0.8,
    curl: 48,                // 涡量强度 —— 墨丝的卷曲程度，是灵魂参数
    // 浮力是加速度，还要顶着压力投影和限速，所以量级比速度大得多
    buoyancy: 600,

    // ---- 交互 ----
    splatRadius: 0.0022,     // 单次落墨的大小
    splatForce: 2000,        // 鼠标推动流体的力度
    inkAmount: 0.15,         // 单次落墨的浓度
    clickBurst: 5,           // 点击时爆发的墨点数量

    // ---- 自动演示 ----
    idle: true,              // 没人动鼠标时自己冒烟
    idleDelay: 2600,         // 静置多久后开始（毫秒）
    intro: true,             // 载入时先来一缕

    // ---- 挂载 ----
    container: null,         // 默认挂到 <body>，作为 z-index:-1 的固定背景
    zIndex: -1,
    dpr: 2                   // 设备像素比上限
  };

  // ---------------------------------------------------------------- shaders

  var VERT = [
    'in vec2 aPos;',
    'out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0);',
    '  vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y);',
    '  vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  // 半拉格朗日平流：沿速度场往回追一步，采样上一帧
  var ADVECT = [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 uTexelSim;',
    'uniform float uDt;',
    'uniform float uDissipation;',
    'void main(){',
    '  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSim;',
    '  vec4 src = texture(uSource, coord);',
    '  fragColor = src / (1.0 + uDissipation * uDt);',
    '}'
  ].join('\n');

  // 高斯落点：往目标场里加一团东西
  var SPLAT = [
    'uniform sampler2D uTarget;',
    'uniform float uAspect;',
    'uniform float uRadius;',
    'uniform vec2 uPoint;',
    'uniform vec3 uColor;',
    'uniform float uMax;',
    'void main(){',
    '  vec2 p = vUv - uPoint;',
    '  p.x *= uAspect;',
    '  vec3 blob = exp(-dot(p, p) / uRadius) * uColor;',
    // 上限：墨最多到全黑就饱和，不会越叠越离谱
    '  fragColor = vec4(min(texture(uTarget, vUv).xyz + blob, vec3(uMax)), 1.0);',
    '}'
  ].join('\n');

  // 旋度（涡量）
  var CURL = [
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float l = texture(uVelocity, vL).y;',
    '  float r = texture(uVelocity, vR).y;',
    '  float t = texture(uVelocity, vT).x;',
    '  float b = texture(uVelocity, vB).x;',
    '  fragColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // 涡量约束 + 浮力：卷曲的墨丝和上升的烟都来自这一步
  var VORTICITY = [
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform sampler2D uDye;',
    'uniform float uCurlStrength;',
    'uniform float uBuoyancy;',
    'uniform float uDt;',
    'void main(){',
    '  float l = texture(uCurl, vL).x;',
    '  float r = texture(uCurl, vR).x;',
    '  float t = texture(uCurl, vT).x;',
    '  float b = texture(uCurl, vB).x;',
    '  float c = texture(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));',
    '  force /= length(force) + 0.0001;',
    '  force *= uCurlStrength * c;',
    '  force.y *= -1.0;',
    '  vec2 vel = texture(uVelocity, vUv).xy;',
    '  vel += force * uDt;',
    '  float d = texture(uDye, vUv).x;',
    '  vel.y += d * uBuoyancy * uDt;',      // 墨越浓，越往上飘
    // 限速。半拉格朗日平流虽然无条件稳定，但一帧回溯超过几个格子就会
    // 采到不相干的区域，画面出现金属反光似的撕裂。
    '  fragColor = vec4(clamp(vel, -160.0, 160.0), 0.0, 1.0);',
    '}'
  ].join('\n');

  var DIVERGENCE = [
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float l = texture(uVelocity, vL).x;',
    '  float r = texture(uVelocity, vR).x;',
    '  float t = texture(uVelocity, vT).y;',
    '  float b = texture(uVelocity, vB).y;',
    '  vec2 c = texture(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) { l = -c.x; }',      // 边界：速度反射，墨不会漏出画面
    '  if (vR.x > 1.0) { r = -c.x; }',
    '  if (vT.y > 1.0) { t = -c.y; }',
    '  if (vB.y < 0.0) { b = -c.y; }',
    '  fragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESSURE = [
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'void main(){',
    '  float l = texture(uPressure, vL).x;',
    '  float r = texture(uPressure, vR).x;',
    '  float t = texture(uPressure, vT).x;',
    '  float b = texture(uPressure, vB).x;',
    '  float div = texture(uDivergence, vUv).x;',
    '  fragColor = vec4((l + r + b + t - div) * 0.25, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var GRADIENT = [
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float l = texture(uPressure, vL).x;',
    '  float r = texture(uPressure, vR).x;',
    '  float t = texture(uPressure, vT).x;',
    '  float b = texture(uPressure, vB).x;',
    '  vec2 vel = texture(uVelocity, vUv).xy;',
    '  vel -= vec2(r - l, t - b);',
    '  fragColor = vec4(vel, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CLEAR = [
    'uniform sampler2D uTexture;',
    'uniform float uValue;',
    'void main(){ fragColor = uValue * texture(uTexture, vUv); }'
  ].join('\n');

  // 上屏：把墨的浓度映射成纸上的墨迹
  var DISPLAY = [
    'uniform sampler2D uDye;',
    'uniform vec3 uPaper;',
    'uniform vec3 uInk;',
    'uniform float uDensity;',
    'uniform float uMaxInk;',
    'uniform float uGrain;',
    'uniform float uFiber;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i), b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
    'void main(){',
    '  float d = max(texture(uDye, vUv).x, 0.0);',
    '  float a = 1.0 - exp(-d * uDensity);',            // 墨的浓度曲线
    '  a += 0.06 * smoothstep(0.015, 0.05, d) * (1.0 - smoothstep(0.05, 0.22, d));', // 边缘的墨晕
    '  a = clamp(a, 0.0, 1.0) * uMaxInk;',   // 封顶，墨再浓也盖不死底下的字
    '  vec3 paper = uPaper;',
    '  paper -= uFiber * (vnoise(vUv * 9.0) - 0.5);',   // 和纸的斑驳
    '  paper -= uFiber * 0.5 * (vnoise(vUv * 37.0) - 0.5);',
    '  vec3 col = mix(paper, uInk, a);',
    '  col -= uGrain * (hash(gl_FragCoord.xy) - 0.5);', // 颗粒
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // ---------------------------------------------------------------- helpers

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function create(userOpts) {
    var o = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    if (userOpts) for (k in userOpts) if (Object.prototype.hasOwnProperty.call(userOpts, k)) o[k] = userOpts[k];

    var host = o.container || document.body;
    var canvas = document.createElement('canvas');
    canvas.className = 'ink-bg';
    canvas.setAttribute('aria-hidden', 'true');
    var cs = canvas.style;
    cs.position = 'fixed';
    cs.top = '0'; cs.left = '0';
    cs.width = '100%'; cs.height = '100%';
    cs.display = 'block';
    cs.zIndex = String(o.zIndex);
    cs.pointerEvents = 'none';   // 不挡页面上的点击
    cs.background = o.paper;

    var gl = canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false,
      antialias: false, preserveDrawingBuffer: false
    });

    // 拿不到 WebGL2 或浮点纹理就退回纯纸色，页面照常可用
    if (!gl || (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))) {
      host.appendChild(canvas);
      return { canvas: canvas, supported: false, destroy: function () { canvas.remove(); } };
    }
    host.appendChild(canvas);

    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- program 编译

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('ink-bg shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
      }
      return s;
    }

    var vs = compile(gl.VERTEX_SHADER, '#version 300 es\nprecision highp float;\n' + VERT);

    function program(fragBody) {
      var fs = compile(gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n' +
        'in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;\n' +
        'out vec4 fragColor;\n' + fragBody);
      var p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('ink-bg link: ' + gl.getProgramInfoLog(p));
      }
      var u = {};
      var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var name = gl.getActiveUniform(p, i).name.replace('[0]', '');
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p: p, u: u };
    }

    var progAdvect = program(ADVECT);
    var progSplat = program(SPLAT);
    var progCurl = program(CURL);
    var progVort = program(VORTICITY);
    var progDiv = program(DIVERGENCE);
    var progPress = program(PRESSURE);
    var progGrad = program(GRADIENT);
    var progClear = program(CLEAR);
    var progDisplay = program(DISPLAY);

    // ---- 全屏三角形

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    function blit(target) {
      if (target) {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      } else {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- FBO

    function makeFBO(w, h, internal, format) {
      var tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.HALF_FLOAT, null);

      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        tex: tex, fbo: fbo, width: w, height: h,
        texelX: 1 / w, texelY: 1 / h,
        // 显式指定纹理单元。不能用自增计数器：压力迭代要跑 22 轮，
        // 计数器绕回来会把还在用的 divergence 挤掉。
        bind: function (unit) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          return unit;
        }
      };
    }

    function makeDouble(w, h, internal, format) {
      var a = makeFBO(w, h, internal, format);
      var b = makeFBO(w, h, internal, format);
      return {
        width: w, height: h, texelX: 1 / w, texelY: 1 / h,
        get read() { return a; },
        get write() { return b; },
        swap: function () { var t = a; a = b; b = t; }
      };
    }

    var velocity, dye, pressure, divergence, curl;

    // 重建前先把旧的显存还回去，否则拖动窗口大小会一直漏
    function disposeFBOs() {
      [velocity, dye, pressure].forEach(function (d) {
        if (!d) return;
        [d.read, d.write].forEach(function (f) {
          gl.deleteTexture(f.tex);
          gl.deleteFramebuffer(f.fbo);
        });
      });
      [divergence, curl].forEach(function (f) {
        if (!f) return;
        gl.deleteTexture(f.tex);
        gl.deleteFramebuffer(f.fbo);
      });
    }

    function initFBOs() {
      disposeFBOs();
      var simW = o.simRes, simH = o.simRes;
      var dyeW = o.dyeRes, dyeH = o.dyeRes;
      var ar = canvas.width / Math.max(canvas.height, 1);
      if (ar > 1) { simW = Math.round(o.simRes * ar); dyeW = Math.round(o.dyeRes * ar); }
      else { simH = Math.round(o.simRes / ar); dyeH = Math.round(o.dyeRes / ar); }

      velocity = makeDouble(simW, simH, gl.RG16F, gl.RG);
      dye = makeDouble(dyeW, dyeH, gl.RGBA16F, gl.RGBA);
      pressure = makeDouble(simW, simH, gl.R16F, gl.RED);
      divergence = makeFBO(simW, simH, gl.R16F, gl.RED);
      curl = makeFBO(simW, simH, gl.R16F, gl.RED);
    }

    // ---- 尺寸

    var bufW = 0, bufH = 0;

    function resize() {
      var dpr = Math.min(global.devicePixelRatio || 1, o.dpr);
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      // 手机上滚动时地址栏收起/展开会不停改变视口高度。重建 FBO 会把墨全部抹掉，
      // 所以高度变化在 20% 以内就忽略，交给浏览器拉伸，肉眼看不出来。
      if (w === bufW && Math.abs(h - bufH) <= bufH * 0.2) return false;
      bufW = w; bufH = h;
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    resize();
    initFBOs();

    // ---- 落墨

    function splat(x, y, dx, dy, amount, radiusScale) {
      var ar = canvas.width / canvas.height;
      var rs = radiusScale === undefined ? 1 : radiusScale;

      gl.useProgram(progSplat.p);
      gl.uniform2f(progSplat.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform1i(progSplat.u.uTarget, velocity.read.bind(0));
      gl.uniform1f(progSplat.u.uAspect, ar);
      gl.uniform2f(progSplat.u.uPoint, x, y);
      gl.uniform3f(progSplat.u.uColor, dx, dy, 0);
      gl.uniform1f(progSplat.u.uRadius, o.splatRadius * rs);
      gl.uniform1f(progSplat.u.uMax, 1e4);
      blit(velocity.write);
      velocity.swap();

      var ink = amount === undefined ? o.inkAmount : amount;
      gl.useProgram(progSplat.p);
      gl.uniform2f(progSplat.u.uTexel, dye.texelX, dye.texelY);
      gl.uniform1i(progSplat.u.uTarget, dye.read.bind(0));
      gl.uniform1f(progSplat.u.uAspect, ar);
      gl.uniform2f(progSplat.u.uPoint, x, y);
      gl.uniform3f(progSplat.u.uColor, ink, ink, ink);
      gl.uniform1f(progSplat.u.uRadius, o.splatRadius * 1.7 * rs);
      gl.uniform1f(progSplat.u.uMax, 1.0);
      blit(dye.write);
      dye.swap();
    }

    // ---- 一步模拟

    function step(dt) {
      gl.disable(gl.BLEND);

      // 涡量
      gl.useProgram(progCurl.p);
      gl.uniform2f(progCurl.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform1i(progCurl.u.uVelocity, velocity.read.bind(0));
      blit(curl);

      // 涡量约束 + 浮力
      gl.useProgram(progVort.p);
      gl.uniform2f(progVort.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform1i(progVort.u.uVelocity, velocity.read.bind(0));
      gl.uniform1i(progVort.u.uCurl, curl.bind(1));
      gl.uniform1i(progVort.u.uDye, dye.read.bind(2));
      gl.uniform1f(progVort.u.uCurlStrength, o.curl);
      gl.uniform1f(progVort.u.uBuoyancy, o.buoyancy);
      gl.uniform1f(progVort.u.uDt, dt);
      blit(velocity.write);
      velocity.swap();

      // 散度
      gl.useProgram(progDiv.p);
      gl.uniform2f(progDiv.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform1i(progDiv.u.uVelocity, velocity.read.bind(0));
      blit(divergence);

      // 压力场衰减
      gl.useProgram(progClear.p);
      gl.uniform2f(progClear.u.uTexel, pressure.texelX, pressure.texelY);
      gl.uniform1i(progClear.u.uTexture, pressure.read.bind(0));
      gl.uniform1f(progClear.u.uValue, o.pressure);
      blit(pressure.write);
      pressure.swap();

      // Jacobi 迭代解压力：divergence 固定在 0 号单元，pressure 每轮换到 1 号
      gl.useProgram(progPress.p);
      gl.uniform2f(progPress.u.uTexel, pressure.texelX, pressure.texelY);
      gl.uniform1i(progPress.u.uDivergence, divergence.bind(0));
      for (var i = 0; i < o.pressureIterations; i++) {
        gl.uniform1i(progPress.u.uPressure, pressure.read.bind(1));
        blit(pressure.write);
        pressure.swap();
      }

      // 减去压力梯度 → 无散速度场
      gl.useProgram(progGrad.p);
      gl.uniform2f(progGrad.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform1i(progGrad.u.uPressure, pressure.read.bind(0));
      gl.uniform1i(progGrad.u.uVelocity, velocity.read.bind(1));
      blit(velocity.write);
      velocity.swap();

      // 平流速度场
      gl.useProgram(progAdvect.p);
      gl.uniform2f(progAdvect.u.uTexel, velocity.texelX, velocity.texelY);
      gl.uniform2f(progAdvect.u.uTexelSim, velocity.texelX, velocity.texelY);
      var vId = velocity.read.bind(0);
      gl.uniform1i(progAdvect.u.uVelocity, vId);
      gl.uniform1i(progAdvect.u.uSource, vId);
      gl.uniform1f(progAdvect.u.uDt, dt);
      gl.uniform1f(progAdvect.u.uDissipation, o.velocityDissipation);
      blit(velocity.write);
      velocity.swap();

      // 平流墨。回溯步长仍用速度场的 texel 单位，所以 uTexelSim 不变
      gl.uniform2f(progAdvect.u.uTexel, dye.texelX, dye.texelY);
      gl.uniform2f(progAdvect.u.uTexelSim, velocity.texelX, velocity.texelY);
      gl.uniform1i(progAdvect.u.uVelocity, velocity.read.bind(0));
      gl.uniform1i(progAdvect.u.uSource, dye.read.bind(1));
      gl.uniform1f(progAdvect.u.uDissipation, o.dyeDissipation);
      blit(dye.write);
      dye.swap();
    }

    var paperRGB = hexToRgb(o.paper);
    var inkRGB = hexToRgb(o.ink);

    function render() {
      gl.useProgram(progDisplay.p);
      gl.uniform2f(progDisplay.u.uTexel, dye.texelX, dye.texelY);
      gl.uniform1i(progDisplay.u.uDye, dye.read.bind(0));
      gl.uniform3f(progDisplay.u.uPaper, paperRGB[0], paperRGB[1], paperRGB[2]);
      gl.uniform3f(progDisplay.u.uInk, inkRGB[0], inkRGB[1], inkRGB[2]);
      gl.uniform1f(progDisplay.u.uDensity, o.density);
      gl.uniform1f(progDisplay.u.uMaxInk, o.maxInk);
      gl.uniform1f(progDisplay.u.uGrain, o.grain);
      gl.uniform1f(progDisplay.u.uFiber, o.fiber);
      blit(null);
    }

    // ---- 交互

    var pointer = { x: 0, y: 0, has: false };
    var lastMove = performance.now();

    function onMove(e) {
      var x = e.clientX / canvas.clientWidth;
      var y = 1 - e.clientY / canvas.clientHeight;   // WebGL 的 y 轴朝上
      if (pointer.has) {
        var dx = (x - pointer.x) * o.splatForce;
        var dy = (y - pointer.y) * o.splatForce;
        if (dx * dx + dy * dy > 0.4) splat(x, y, dx, dy);
      }
      pointer.x = x; pointer.y = y; pointer.has = true;
      lastMove = performance.now();
    }

    function onDown(e) {
      var x = e.clientX / canvas.clientWidth;
      var y = 1 - e.clientY / canvas.clientHeight;
      for (var i = 0; i < o.clickBurst; i++) {
        var a = Math.random() * Math.PI * 2;
        var s = 40 + Math.random() * 110;
        splat(x, y, Math.cos(a) * s, Math.sin(a) * s + 50, o.inkAmount * 1.5);
      }
      pointer.x = x; pointer.y = y; pointer.has = true;
      lastMove = performance.now();
    }

    function onLeave() { pointer.has = false; }

    global.addEventListener('pointermove', onMove, { passive: true });
    global.addEventListener('pointerdown', onDown, { passive: true });
    global.addEventListener('pointerout', onLeave, { passive: true });

    // ---- 自动飘烟（没人动鼠标时）

    // 一团一团地吐，而不是持续喷。
    // 封闭区域里持续喷会形成稳态对流环，把墨又卷回原地，看着像一坨不动的球；
    // 间歇的小团各自升腾、卷曲、消散，才是想要的那种「自己在飘」。
    var idlePhase = Math.random() * 1000;
    var nextPuff = 0;

    function idleEmit(now, dt) {
      if (!o.idle || reduced) return;
      if (now - lastMove < o.idleDelay) return;
      if (now < nextPuff) return;
      nextPuff = now + 850 + Math.random() * 1000;

      idlePhase += 1;
      var x = 0.5 + 0.22 * Math.sin(idlePhase * 0.7) + (Math.random() - 0.5) * 0.18;
      var y = 0.12 + Math.random() * 0.08;
      for (var i = 0; i < 4; i++) {
        splat(x + (Math.random() - 0.5) * 0.03, y + i * 0.012,
          (Math.random() - 0.5) * 70, 40 + Math.random() * 50,
          o.inkAmount * 0.55, 0.7);
      }
    }

    // ---- 主循环

    var last = performance.now();
    var raf = 0;
    var running = true;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!running) { last = now; return; }

      var dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      if (dt <= 0) return;

      if (resize()) initFBOs();
      idleEmit(now, dt);
      step(dt);
      render();
    }

    // 载入时先来一缕，别一上来是张白纸
    if (o.intro && !reduced) {
      for (var i = 0; i < 6; i++) {
        var t = i / 6;
        splat(0.5 + (Math.random() - 0.5) * 0.05, 0.22 + t * 0.06,
          (Math.random() - 0.5) * 60, 70 + Math.random() * 50, o.inkAmount * 0.8);
      }
    }

    function onVisibility() {
      running = !document.hidden;
      last = performance.now();
    }
    document.addEventListener('visibilitychange', onVisibility);

    raf = requestAnimationFrame(frame);

    // ---- 对外接口

    return {
      canvas: canvas,
      supported: true,
      options: o,
      /** 手动落一笔墨，坐标是 0~1 的 uv（y 轴朝上） */
      splat: function (x, y, dx, dy, amount) { splat(x, y, dx || 0, dy || 0, amount); },
      pause: function () { running = false; },
      resume: function () { running = true; last = performance.now(); },
      destroy: function () {
        cancelAnimationFrame(raf);
        global.removeEventListener('pointermove', onMove);
        global.removeEventListener('pointerdown', onDown);
        global.removeEventListener('pointerout', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
        var ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
        canvas.remove();
      }
    };
  }

  global.InkBackground = { create: create, defaults: DEFAULTS };

  // <script src="ink-bg.js" data-auto> 时自动启动
  var self = document.currentScript;
  if (self && self.hasAttribute('data-auto')) {
    var boot = function () { create(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(window);
