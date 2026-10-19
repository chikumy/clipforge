/** Only same-site relative paths; blocks open redirects such as //evil.com or /\evil.com. */
export const safeNext = (value: unknown, fallback = "/onboarding"): string =>
  typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : fallback;
