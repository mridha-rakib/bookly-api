// Only this explicit development entry point installs these four composition seams.
const source = new URL("../../src/modules/booking/", import.meta.url);
const overrides = new URL("./overrides/", import.meta.url);
const normalize = (url) =>
  decodeURIComponent(url.split("?")[0]).replaceAll("\\", "/").toLowerCase();
const targets = new Map(
  [
    ["package-batch-authority.ts", "package-batch-authority.ts"],
    ["package-consent-http-activation.ts", "package-consent-http-activation.ts"],
    ["trusted-time/qualified-host.ts", "qualified-host.ts"],
    ["trusted-time/host-clock.ts", "host-clock.ts"],
  ].map(([from, to]) => [normalize(new URL(from, source).href), new URL(to, overrides).href]),
);
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const replacement = targets.get(normalize(result.url));
  if (
    !replacement ||
    (context.parentURL && normalize(context.parentURL).startsWith(normalize(overrides.href)))
  )
    return result;
  return { ...result, url: replacement, shortCircuit: true };
}
