local cmd = require("cmd")
local json = require("json")

function PLUGIN:MiseEnv(ctx)
    -- This fixed bootstrap only locates the checkout's installed CLI. Session logic
    -- belongs to that CLI, never to the globally installed adapter.
    local bootstrap = [[
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
let root = fs.realpathSync(process.cwd());
while (!fs.existsSync(path.join(root, "devtree.config.ts"))) {
  const parent = path.dirname(root);
  if (parent === root) throw new Error("No devtree.config.ts found. Run devtree setup --interactive in your project.");
  root = parent;
}
const candidates = ["devtree", "@mdulghier/devtree"].map(name => path.join(root, "node_modules", name));
const installed = candidates.find(dir => {
  const file = path.join(dir, "package.json");
  return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === "@mdulghier/devtree";
});
if (!installed) throw new Error("Devtree is not installed in " + root + ". Install this project's dependencies, then refresh mise.");
const metadata = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin.devtree;
const result = cp.spawnSync(process.execPath, [path.resolve(installed, bin), "env", "--json"], {cwd: root, encoding: "utf8", env: process.env});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || "devtree env --json failed");
process.stdout.write(result.stdout);
]]
    local output = cmd.exec("node -e '" .. bootstrap:gsub("'", "'\\''") .. "'")
    local values = json.decode(output)
    local entries = {}
    for key, value in pairs(values) do
        if type(key) ~= "string" or type(value) ~= "string" then
            error("devtree env --json must return an object of string values")
        end
        table.insert(entries, { key = key, value = value })
    end
    return { env = entries, cacheable = false }
end
