import { readFileSync, writeFileSync } from "node:fs";

const sdkBundle = "node_modules/@mega-yfue/eufy-sdk/dist/index.js";
let source = readFileSync(sdkBundle, "utf8");

if (/custom1\s*:\s*"custom1"/.test(source)) {
  console.log("[patch] eufy-sdk custom arming modes already enabled");
  process.exit(0);
}

const armingModeObject =
  /(ArmingMode\s*=\s*\{\s*away\s*:\s*"away"\s*,\s*home\s*:\s*"home"\s*,)(\s*disarmed\s*:\s*"disarmed"\s*\})/;

if (!armingModeObject.test(source)) {
  throw new Error("Unable to locate ArmingMode in @mega-yfue/eufy-sdk bundle");
}

source = source.replace(
  armingModeObject,
  '$1 custom1: "custom1", custom2: "custom2", custom3: "custom3",$2',
);

writeFileSync(sdkBundle, source);
console.log("[patch] enabled arming modes custom1/custom2/custom3 (wire 3/4/5)");
