import { ROOM_FIELD_SHADER_CHUNK } from "./room-field";

// Integrated phases wrap on integer harmonics of this period, without a jump.
export const AMBIENT_PHASE_PERIOD_SECONDS = 256;

export const roomVertexShader = /* glsl */ `
attribute vec2 aRoomCoord;
attribute float aRoomSurface;
varying vec2 vRoomCoord;
varying float vRoomSurface;
${ROOM_FIELD_SHADER_CHUNK}

void main() {
  vRoomCoord = aRoomCoord;
  vRoomSurface = aRoomSurface;
  vec3 world = warpedRoomSurface(aRoomCoord, aRoomSurface);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
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
uniform float uVolume;
uniform sampler2D uCloudStates;
uniform vec2 uCloudStateSize;
attribute float aCloudIndex;
attribute float aCloudSize;
attribute float aCloudAlpha;
attribute float aCloudRim;
attribute float aCloudSeed;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;
varying float vCloudSeed;

vec4 cloudState(float column) {
  return texture2D(uCloudStates, vec2((column + 0.5) / uCloudStateSize.x,
    (aCloudIndex + 0.5) / uCloudStateSize.y));
}

void main() {
  vec4 centrePhase = cloudState(0.0);
  vec4 radiusEnergy = cloudState(1.0);
  vec4 metadata = cloudState(2.0);
  float phase = 6.28318530718 * centrePhase.w / ${AMBIENT_PHASE_PERIOD_SECONDS.toFixed(1)};
  float frequencyX = 7.0 + floor(aCloudSeed * 7.0);
  float frequencyY = 8.0 + floor(aCloudSeed * 8.0);
  float driftCss = 3.0 + aCloudSeed * 5.0;
  vec3 drift = vec3(
    sin(phase * frequencyX + aCloudSeed * 19.0),
    cos(phase * frequencyY + aCloudSeed * 23.0),
    sin(phase * (frequencyX - 1.0) + aCloudSeed * 29.0) * 0.35
  ) * driftCss * metadata.y;
  vec3 displaced = centrePhase.xyz + position * radiusEnergy.xyz + drift;
  vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  float cssSize = aCloudSize * (0.8 + radiusEnergy.w * 0.55);
  float volumeSize = (7.0 + 11.0 * (1.0 - clamp(length(position), 0.0, 1.0))) *
    (0.75 + radiusEnergy.w * 0.35);
  gl_PointSize = mix(clamp(cssSize, 0.65, 3.4), clamp(volumeSize, 4.0, 22.0), uVolume) * uPixelRatio;
  vCloudEnergy = radiusEnergy.w;
  vCloudAlpha = metadata.x * aCloudAlpha;
  vCloudRim = aCloudRim;
  vCloudSeed = aCloudSeed;
}
`;

export const cloudLineFragmentShader = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uEnergy;
uniform vec3 uShade;
uniform vec3 uRim;
uniform float uOpacity;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;
varying float vCloudSeed;

void main() {
  vec3 colour = mix(uInk, uEnergy, clamp(vCloudEnergy, 0.0, 1.0) * 0.7);
  colour = mix(colour, uShade, 0.2 + (1.0 - vCloudSeed) * 0.18);
  colour = mix(colour, uRim, vCloudRim * 0.48);
  gl_FragColor = vec4(colour, vCloudAlpha * 0.42 * uOpacity);
  #include <colorspace_fragment>
}
`;

export const cloudFragmentShader = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uEnergy;
uniform vec3 uShade;
uniform vec3 uRim;
uniform float uOpacity;
uniform float uVolume;
varying float vCloudEnergy;
varying float vCloudAlpha;
varying float vCloudRim;
varying float vCloudSeed;

void main() {
  vec2 centred = gl_PointCoord * 2.0 - 1.0;
  float radius = length(centred);
  if (radius > 1.0) discard;
  vec3 colour = mix(uInk, uEnergy, clamp(vCloudEnergy, 0.0, 1.0) * 0.7);
  float light = clamp(0.78 - centred.x * 0.2 + centred.y * 0.3 - radius * 0.3, 0.0, 1.0);
  colour = mix(uShade, colour, 0.3 + light * 0.7);
  colour = mix(colour, uRim, smoothstep(0.42, 0.96, radius) * vCloudRim * 0.48);
  float particle = pow(1.0 - smoothstep(0.12, 1.0, radius), 1.35);
  float volume = exp(-3.8 * radius * radius) * (1.0 - smoothstep(0.62, 1.0, radius));
  float coverage = mix(particle, volume * 0.22, uVolume) * vCloudAlpha;
  gl_FragColor = vec4(colour, coverage * uOpacity);
  #include <colorspace_fragment>
}
`;
