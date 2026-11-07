// Registers the BC-F05C local acceptance hooks. Use ONLY with dev/local-acceptance/server.ts.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
