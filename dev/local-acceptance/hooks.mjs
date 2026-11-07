// BC-F05C LOCAL ACCEPTANCE module hooks (NON-PRODUCTION). Redirects exactly four shipped src
// modules to dev/local-acceptance/overrides when imported from anywhere except the overrides
// themselves (which import the shipped originals). Nothing else is redirected.
const here = new URL("./", import.meta.url);
const overridesDir = new URL("./overrides/", here).href;
const src = new URL("../../src/modules/booking/", here).href;
const targets = [
  ["package-batch-authority.ts", "package-batch-authority.ts"],
  ["trusted-time/qualified-host.ts", "qualified-host.ts"],
  ["trusted-time/host-clock.ts", "host-clock.ts"],
  ["package-consent-http-activation.ts", "package-consent-http-activation.ts"],
];
const norm = (u) => decodeURIComponent(u.split("?")[0]).split("\\").join("/").toLowerCase();
const redirects = new Map(targets.map(([from, to]) => [norm(src + from), overridesDir + to]));
const overridesPrefix = norm(overridesDir);

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const replacement = redirects.get(norm(result.url));
  if (!replacement) return result;
  if (context.parentURL && norm(context.parentURL).startsWith(overridesPrefix)) return result;
  return { ...result, url: replacement, shortCircuit: true };
}
