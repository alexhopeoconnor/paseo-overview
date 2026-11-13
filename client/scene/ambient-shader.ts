// A bounded integrated clock shared by the restrained cloud drift. The period
// uses simple sine harmonics so wrapping does not introduce a visible jump.
export const AMBIENT_PHASE_PERIOD_SECONDS = 256;

export const roomVertexShader = /* glsl */ `
attribute vec2 aRoomCoord;
attribute float aRoomSurface;
varying vec2 vRoomCoord;
varying float vRoomSurface;

void main() {
  vRoomCoord = aRoomCoord;
  vRoomSurface = aRoomSurface;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const roomFragmentShader = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uGlow;
uniform vec3 uShade;
uniform vec3 uRim;
uniform float uLineOpacity;
uniform float uShadeOpacity;
uniform float uRimOpacity;
uniform float uPixelRatio;
varying vec2 vRoomCoord;
varying float vRoomSurface;

vec2 gridAxes(vec2 gridPosition, float halfWidthPx) {
  vec2 distanceToLine = abs(fract(gridPosition + 0.5) - 0.5);
  vec2 footprint = max(fwidth(gridPosition), vec2(0.00001));
  vec2 distancePx = distanceToLine / footprint;
  vec2 densityFade = smoothstep(vec2(1.2), vec2(3.8), 1.0 / footprint);
  return (1.0 - smoothstep(vec2(halfWidthPx - 0.55), vec2(halfWidthPx + 0.55), distancePx)) * densityFade;
}

void main() {
  vec2 majorAxes = gridAxes(vRoomCoord, 0.46 * uPixelRatio);
  vec2 minorAxes = gridAxes(vRoomCoord * 2.5, 0.24 * uPixelRatio);
  float major = max(majorAxes.x, majorAxes.y);
  float minor = max(minorAxes.x, minorAxes.y) * 0.24;
  // The shared floor/wall coordinate is zero at their exact 3D seam. Fading
  // both coincident contours avoids a false glowing horizon or a double line.
  float seamQuiet = smoothstep(0.0, 0.1, abs(vRoomCoord.y));
  float grid = (major + minor) * seamQuiet;
  vec3 colour = mix(uLine, uRim, uRimOpacity * 0.3);
  colour = mix(colour, uGlow, minor * 0.12);
  float fill = uShadeOpacity * mix(0.055, 0.022, vRoomSurface);
  float gridAlpha = grid * uLineOpacity * 0.82;
  vec3 premultiplied = uShade * fill;
  float coverage = fill;
  premultiplied = colour * gridAlpha + premultiplied * (1.0 - gridAlpha);
  coverage = gridAlpha + coverage * (1.0 - gridAlpha);
  gl_FragColor = vec4(coverage > 0.00001 ? premultiplied / coverage : uLine, coverage);
  #include <colorspace_fragment>
}
`;

export const cloudVertexShader = /* glsl */ `
uniform float uPhase;
uniform float uPixelRatio;
uniform float uViewportHeight;
attribute float aCloudSize;
attribute float aCloudEnergy;
attribute float aCloudAlpha;
attribute float aCloudRim;
attribute float aCloudSeed;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;

void main() {
  vec3 displaced = position;
  // Only the particle volume breathes. Its centre and therefore the stream
  // destination remain fixed on the graph's exactly projected centre.
  float phase = 6.28318530718 * uPhase / ${AMBIENT_PHASE_PERIOD_SECONDS.toFixed(1)};
  displaced.x += sin(phase + aCloudSeed * 19.0) * aCloudSize * 0.32;
  displaced.y += cos(phase * 2.0 + aCloudSeed * 23.0) * aCloudSize * 0.25;
  vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  float pointSize = aCloudSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(1.0, -viewPosition.z);
  gl_PointSize = clamp(pointSize, 0.65 * uPixelRatio, 3.4 * uPixelRatio);
  vCloudEnergy = aCloudEnergy;
  vCloudAlpha = aCloudAlpha;
  vCloudRim = aCloudRim;
}
`;

export const cloudLineFragmentShader = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uEnergy;
uniform vec3 uRim;
uniform float uOpacity;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;

void main() {
  vec3 colour = mix(uInk, uEnergy, clamp(vCloudEnergy, 0.0, 1.0) * 0.7);
  colour = mix(colour, uRim, vCloudRim * 0.48);
  gl_FragColor = vec4(colour, vCloudAlpha * 0.42 * uOpacity);
  #include <colorspace_fragment>
}
`;

export const cloudFragmentShader = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uEnergy;
uniform vec3 uRim;
uniform float uOpacity;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;

void main() {
  vec2 centred = gl_PointCoord * 2.0 - 1.0;
  float radius = length(centred);
  if (radius > 1.0) discard;
  float coverage = (1.0 - smoothstep(0.25, 1.0, radius)) * vCloudAlpha;
  vec3 colour = mix(uInk, uEnergy, clamp(vCloudEnergy, 0.0, 1.0) * 0.7);
  colour = mix(colour, uRim, vCloudRim * 0.48);
  gl_FragColor = vec4(colour, coverage * uOpacity);
  #include <colorspace_fragment>
}
`;
