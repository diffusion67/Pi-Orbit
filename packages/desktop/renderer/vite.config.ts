import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rendererRoot = fileURLToPath(new URL(".", import.meta.url));
const rendererOutput = fileURLToPath(new URL("../dist/renderer", import.meta.url));

export default defineConfig({
	root: rendererRoot,
	base: "./",
	build: {
		outDir: rendererOutput,
		emptyOutDir: true,
	},
});
