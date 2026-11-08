import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

// Execute with the maintained host compiler's tsx loader in the pinned build
// container. Output belongs outside the source repository.
const fork = process.env.OVERVIEW_FORK_ROOT || "/fork";
const plugin = process.env.OVERVIEW_PLUGIN_ROOT || "/plugin";
const output = process.env.OVERVIEW_ACCEPTANCE_OUTPUT || "/out";
const { compilePlugin } = await import(pathToFileURL(resolve(fork, "packages/server/src/server/plugins/compiler-build.ts")));
await mkdir(output, { recursive: true });
const bundles = await compilePlugin({ client: resolve(plugin, "index.client.tsx"), server: resolve(plugin, "index.server.ts") });
await writeFile(resolve(output, "client.js"), `${bundles.clientBundle};\n`);
await writeFile(resolve(output, "server.js"), `${bundles.serverBundle};\n`);
const hermes = spawnSync(resolve(fork, "node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"), ["-emit-binary", "-out", resolve(output, "client.hbc"), resolve(output, "client.js")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
await writeFile(resolve(output, "hermes-diagnostics.log"), hermes.stderr || "");
if (hermes.status !== 0) throw new Error(`Hermes failed: ${hermes.status}; see hermes-diagnostics.log`);
const require = createRequire(process.env.OVERVIEW_HOST_REQUIRE || resolve(plugin, "package.json"));
const registered = [];
const fake = {
  "react": require("react"), "react/jsx-runtime": require("react/jsx-runtime"),
  "react-native": { Platform: { OS: "android" }, StyleSheet: { create: value => value }, View() {}, Text() {}, ScrollView() {}, Pressable() {}, Image() {}, AppState: {} },
  "@getpaseo/plugin": require("@getpaseo/plugin"),
  "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": { SidebarRow() {} },
  "zod": require("zod"),
};
const context = vm.createContext({ console, setTimeout, clearTimeout });
const native = vm.runInContext(bundles.clientBundle, context)(name => {
  if (!(name in fake)) throw new Error(`Unexpected host import: ${name}`);
  return fake[name];
});
const cleanup = native.default({
  addScreen(value) { registered.push(value); return () => {}; },
  addSidebarHeaderItem(value) { registered.push(value); return () => {}; },
});
if (registered.length !== 2 || registered[0].title !== "Overview") throw new Error("Unexpected client contributions");
cleanup();
console.log(JSON.stringify({ clientBytes: Buffer.byteLength(bundles.clientBundle), serverBytes: Buffer.byteLength(bundles.serverBundle), hermesParse: true, nativeRegistrationWithoutDOM: true, contributions: registered.map(item => item.id) }));
