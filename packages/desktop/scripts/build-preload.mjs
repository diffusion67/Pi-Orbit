import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { desktopCommandSchemas } from "../src/shared/commands.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const source = await readFile(join(packageRoot, "src", "preload.ts"), "utf8");
const output = await transform(source, { loader: "ts", format: "cjs", target: "node22" });
const destination = join(packageRoot, "dist", "preload.cjs");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `const __PI_ORBIT_COMMANDS__ = ${JSON.stringify(Object.keys(desktopCommandSchemas))};\n${output.code}`);
