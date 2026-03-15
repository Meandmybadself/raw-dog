export const ADJUSTMENT_VERT = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

export const ADJUSTMENT_FRAG = /* glsl */`#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texture;

uniform float u_exposure;
uniform mat3 u_wbMatrix;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_clarity;
uniform float u_vibrance;
uniform float u_saturation;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// sRGB decode: gamma-encoded [0,1] → linear light [0,1]
float sRGBToLinear(float x) {
  return x <= 0.04045
    ? x / 12.92
    : pow((x + 0.055) / 1.055, 2.4);
}

vec3 sRGBToLinearV(vec3 c) {
  return vec3(sRGBToLinear(c.r), sRGBToLinear(c.g), sRGBToLinear(c.b));
}

// sRGB encode: linear light [0,1] → gamma-encoded [0,1]
float linearToSRGB(float x) {
  x = clamp(x, 0.0, 1.0);
  return x <= 0.0031308
    ? 12.92 * x
    : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

vec3 linearToSRGBv(vec3 c) {
  return vec3(linearToSRGB(c.r), linearToSRGB(c.g), linearToSRGB(c.b));
}

// Luminance-preserving color adjustment.
// When brightening, blend toward white to avoid clipping saturated channels.
// When darkening, scale proportionally to preserve hue.
vec3 adjustLuminance(vec3 c, float oldLum, float newLum) {
  if (oldLum < 0.0001) return vec3(newLum);
  if (newLum > oldLum) {
    // Brightening: interpolate toward white by the ratio of luminance increase
    // to available headroom. This lifts all channels while preventing oversaturation.
    float headroom = max(1.0 - oldLum, 0.001);
    float t = (newLum - oldLum) / headroom;
    return c + t * (vec3(1.0) - c);
  } else {
    // Darkening: scale proportionally (preserves hue)
    return c * (newLum / oldLum);
  }
}

// Soft bell-curve mask centered at 'center' with width 'width'.
// Returns 1.0 at center, fading to 0.0 at center ± width.
float bellMask(float t, float center, float width) {
  float d = (t - center) / width;
  return exp(-d * d * 2.0);
}

vec3 applyContrast(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float t = clamp(lum, 0.0, 1.0);
  // S-curve via symmetric power function around 0.5
  float power = strength > 0.0
    ? 1.0 / (1.0 + strength * 2.0)
    : 1.0 + abs(strength) * 2.0;
  float newLum = t < 0.5
    ? 0.5 * pow(2.0 * t, power)
    : 1.0 - 0.5 * pow(2.0 * (1.0 - t), power);
  return clamp(adjustLuminance(c, lum, newLum), 0.0, 1.0);
}

// Highlights: targets the upper tonal range using overlapping bell+ramp masks.
// The mask is designed to affect everything above ~sRGB 0.5 with peak at the top.
vec3 applyHighlights(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float t = clamp(lum, 0.0, 1.0);

  // Perceptual t: work in a gamma-like space for more intuitive masking
  float pt = sqrt(t);

  // Broad ramp that covers the upper half of the tonal range
  // pt=0.5 (≈sRGB 0.5) → 0.0, pt=1.0 → 1.0
  float mask = smoothstep(0.4, 0.95, pt);

  // Additional weight: stronger effect on brighter pixels
  float weight = mask * mask;

  float targetLum;
  if (strength < 0.0) {
    // Recovery: pull highlights down via soft-knee compression.
    // Remap the bright range through a curve that bends high values down.
    float amount = abs(strength);
    // Blend toward a compressed curve: pow(t, 1+amount)
    float compressed = pow(t, 1.0 + amount * 1.2);
    targetLum = mix(t, compressed, weight);
  } else {
    // Boost: push highlights up toward 1.0
    float headroom = 1.0 - t;
    targetLum = t + strength * weight * headroom * 0.8;
  }
  targetLum = clamp(targetLum, 0.0, 1.0);

  return clamp(adjustLuminance(c, lum, targetLum), 0.0, 1.0);
}

// Shadows: targets the lower tonal range.
// Positive strength lifts shadows, negative crushes them.
vec3 applyShadows(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float t = clamp(lum, 0.0, 1.0);

  // Work in perceptual space for more even effect distribution
  float pt = sqrt(t);

  // Broad ramp covering lower half: pt=0.0→1.0, pt=0.6→0.0
  float mask = 1.0 - smoothstep(0.05, 0.6, pt);

  float targetLum;
  if (strength > 0.0) {
    // Lift: use a strong gamma curve and blend with mask
    float gamma = 1.0 / (1.0 + strength * 3.0);
    float lifted = pow(t, gamma);
    targetLum = mix(t, lifted, mask);
  } else {
    // Crush: deepen shadows with a power curve
    float gamma = 1.0 + abs(strength) * 3.0;
    float crushed = pow(t, gamma);
    targetLum = mix(t, crushed, mask);
  }
  targetLum = clamp(targetLum, 0.0, 1.0);

  return clamp(adjustLuminance(c, lum, targetLum), 0.0, 1.0);
}

// Whites: narrow endpoint adjustment for the very brightest values.
vec3 applyWhites(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float t = clamp(lum, 0.0, 1.0);
  float pt = sqrt(t);
  float mask = smoothstep(0.65, 0.95, pt);
  float targetLum;
  if (strength > 0.0) {
    targetLum = t + strength * mask * (1.0 - t) * 0.9;
  } else {
    targetLum = t + strength * mask * t * 0.5;
  }
  targetLum = clamp(targetLum, 0.0, 1.0);
  return clamp(adjustLuminance(c, lum, targetLum), 0.0, 1.0);
}

// Blacks: narrow endpoint adjustment for the darkest values.
vec3 applyBlacks(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float t = clamp(lum, 0.0, 1.0);
  float pt = sqrt(t);
  float mask = 1.0 - smoothstep(0.0, 0.3, pt);
  float targetLum;
  if (strength < 0.0) {
    // Crush blacks deeper
    float gamma = 1.0 + abs(strength) * 4.0;
    targetLum = mix(t, pow(t, gamma), mask);
  } else {
    // Lift blacks
    targetLum = t + strength * mask * 0.3;
  }
  targetLum = clamp(targetLum, 0.0, 1.0);
  return clamp(adjustLuminance(c, lum, targetLum), 0.0, 1.0);
}

vec3 applyClarity(vec3 c, vec2 uv, float strength) {
  if (abs(strength) < 0.001) return c;
  // Approximate local contrast via 5-tap cross blur
  vec2 texelSize = 1.0 / vec2(textureSize(u_texture, 0));
  vec2 offset = texelSize * 4.0; // 4-pixel radius
  vec3 blurred = texture(u_texture, uv).rgb * 0.2
    + texture(u_texture, uv + vec2(offset.x, 0.0)).rgb * 0.2
    + texture(u_texture, uv - vec2(offset.x, 0.0)).rgb * 0.2
    + texture(u_texture, uv + vec2(0.0, offset.y)).rgb * 0.2
    + texture(u_texture, uv - vec2(0.0, offset.y)).rgb * 0.2;
  vec3 detail = c - blurred;
  float lum = luminance(c);
  float midtoneMask = sin(clamp(lum, 0.0, 1.0) * 3.14159);
  return clamp(c + detail * strength * 0.6 * midtoneMask, 0.0, 1.0);
}

vec3 applySaturation(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  return clamp(mix(vec3(lum), c, 1.0 + strength), 0.0, 1.0);
}

vec3 applyVibrance(vec3 c, float strength) {
  if (abs(strength) < 0.001) return c;
  float lum = luminance(c);
  float cMax = max(c.r, max(c.g, c.b));
  float cMin = min(c.r, min(c.g, c.b));
  float chroma = cMax - cMin;
  float satProtect = 1.0 - chroma;
  float skinMask = 0.0;
  if (c.r > c.g && c.g > c.b && chroma > 0.05) {
    float hueRatio = (c.r - c.g) / (chroma + 0.0001);
    skinMask = smoothstep(0.25, 0.45, hueRatio) * (1.0 - smoothstep(0.65, 0.85, hueRatio));
    skinMask *= smoothstep(0.03, 0.15, chroma);
  }
  float effective = strength * satProtect * (1.0 - skinMask * 0.7);
  return clamp(mix(vec3(lum), c, 1.0 + effective), 0.0, 1.0);
}

void main() {
  vec4 sample_ = texture(u_texture, v_uv);
  vec3 c = sample_.rgb;

  // 0. Input is sRGB gamma-encoded from libraw (outputBps:8) — linearize first
  c = sRGBToLinearV(c);

  // 1. White balance (Bradford CAT matrix, operates in linear light)
  c = u_wbMatrix * c;
  c = max(c, vec3(0.0));

  // 2. Exposure (in linear light — multiply by 2^stops)
  c *= pow(2.0, u_exposure);

  // 3. Highlights, shadows, whites, blacks
  c = applyHighlights(c, u_highlights);
  c = applyShadows(c, u_shadows);
  c = applyWhites(c, u_whites);
  c = applyBlacks(c, u_blacks);

  // 4. Contrast
  c = applyContrast(c, u_contrast);

  // 5. Clarity
  c = applyClarity(c, v_uv, u_clarity);

  // 6. Saturation and vibrance
  c = applySaturation(c, u_saturation);
  c = applyVibrance(c, u_vibrance);

  // 7. Re-encode to sRGB gamma
  c = linearToSRGBv(c);

  fragColor = vec4(c, 1.0);
}
`
