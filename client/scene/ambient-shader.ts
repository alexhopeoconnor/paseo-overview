/** One CSS-pixel grid surface. Geometry coverage stays fixed; aWarp bends only pattern coordinates. */
export const ambientVertexShader = /* glsl */ `
uniform vec2 uViewport;
attribute vec2 aOverviewGridWarp;
attribute float aOverviewGridIntensity;
attribute float aOverviewGridQuiet;
varying vec2 vCss;
varying vec2 vPatternCss;
varying float vIntensity;
varying float vQuiet;

void main() {
  vec2 css = vec2((position.x * 0.5 + 0.5) * uViewport.x, (0.5 - position.y * 0.5) * uViewport.y);
  vCss = css;
  vPatternCss = css + aOverviewGridWarp;
  vIntensity = aOverviewGridIntensity;
  vQuiet = aOverviewGridQuiet;
  // aOverviewGridWarp deliberately affects only pattern coordinates. The plane
  // itself stays fitted to the viewport, so local distortion cannot reveal edges.
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const ambientFragmentShader = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uHighlight;
uniform vec3 uGlow;
uniform vec2 uViewport;
uniform float uPixelRatio;
uniform float uTime;
uniform float uLineOpacity;
uniform float uHighlightOpacity;
varying vec2 vCss;
varying vec2 vPatternCss;
varying float vIntensity;
varying float vQuiet;

vec2 gridAxes(vec2 gridPosition, float halfWidthPx) {
  vec2 distanceToLine = abs(fract(gridPosition + 0.5) - 0.5);
  vec2 footprint = max(fwidth(gridPosition), vec2(0.0001));
  vec2 distancePx = distanceToLine / footprint;
  // Derivative antialiasing handles each stroke. Fade entire compressed axes
  // before neighbouring strokes become indistinguishable or shimmer at zoom.
  vec2 densityFade = smoothstep(vec2(2.0), vec2(5.0), 1.0 / footprint);
  return (1.0 - smoothstep(vec2(halfWidthPx - 0.5), vec2(halfWidthPx + 0.5), distancePx)) * densityFade;
}

float gridLine(vec2 gridPosition, float halfWidthPx) {
  vec2 axes = gridAxes(gridPosition, halfWidthPx);
  return max(axes.x, axes.y);
}

float hash21(vec2 value) {
  value = fract(value * vec2(123.34, 456.21));
  value += dot(value, value + 45.32);
  return fract(value.x * value.y);
}

void main() {
  float viewportHeight = max(1.0, uViewport.y);
  float depth = clamp(vPatternCss.y / viewportHeight, 0.0, 1.0);
  // A restrained horizon: lines compress gently toward the top without a moving camera.
  float lateralScale = mix(0.62, 1.12, depth);
  float vertical = pow(depth, 1.24) * viewportHeight / 46.0;
  vec2 gridPosition = vec2((vPatternCss.x - uViewport.x * 0.5) / (46.0 * lateralScale), vertical);
  float major = gridLine(gridPosition, 0.48 * uPixelRatio);
  float minor = gridLine(gridPosition * 2.5, 0.25 * uPixelRatio) * 0.24;
  float quiet = mix(1.0, 0.52, vQuiet);
  float grid = (major + minor) * quiet;

  // Identity belongs to an entire grid line, not each cell it crosses. A
  // travelling highlight therefore keeps its phase and speed across junctions.
  vec2 lineId = floor(gridPosition + 0.5);
  float verticalIdentity = hash21(vec2(lineId.x, 17.0));
  float horizontalIdentity = hash21(vec2(31.0, lineId.y));
  float verticalSpeed = mix(0.18, 0.42, hash21(vec2(lineId.x, 18.7)));
  float horizontalSpeed = mix(0.18, 0.42, hash21(vec2(43.7, lineId.y)));
  float verticalSegment = 1.0 - smoothstep(0.09, 0.19, abs(fract(gridPosition.y * 0.52 - uTime * verticalSpeed + verticalIdentity) - 0.5));
  float horizontalSegment = 1.0 - smoothstep(0.09, 0.19, abs(fract(gridPosition.x * 0.52 - uTime * horizontalSpeed + horizontalIdentity) - 0.5));
  vec2 highlightAxes = gridAxes(gridPosition, 0.85 * uPixelRatio);
  float highlights = step(verticalIdentity, 0.15) * highlightAxes.x * verticalSegment +
    step(horizontalIdentity, 0.15) * highlightAxes.y * horizontalSegment;
  highlights *= quiet * (0.35 + 0.65 * vIntensity);

  float illumination = clamp(vIntensity, 0.0, 1.0);
  vec3 gridColour = mix(uLine, uGlow, illumination * 0.72);
  gridColour = mix(gridColour, uHighlight, highlights);
  float gridAlpha = grid * (uLineOpacity + illumination * 0.11) + highlights * uHighlightOpacity;
  gl_FragColor = vec4(gridColour, clamp(gridAlpha, 0.0, 0.72));
  #include <colorspace_fragment>
}
`;
