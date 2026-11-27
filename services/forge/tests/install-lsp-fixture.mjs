import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.argv[2];
if (!root) throw new Error("Expected fixture destination");
const compiler = dirname(require.resolve("typescript/package.json"));
const compilerRequire = createRequire(join(compiler, "package.json"));
const platform = `@typescript/typescript-${process.platform}-${process.arch}`;
mkdirSync(join(root, "node_modules/@typescript"), { recursive: true });
cpSync(compiler, join(root, "node_modules/typescript"), { recursive: true, dereference: true });
cpSync(dirname(compilerRequire.resolve(`${platform}/package.json`)), join(root, "node_modules", platform), {
	recursive: true,
	dereference: true,
});
writeFileSync(join(root, "package.json"), '{"private":true}');
writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
writeFileSync(join(root, "index.ts"), 'export const value: string = "fixture";\nconsole.log(value);\n');
