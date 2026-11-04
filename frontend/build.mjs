import { build } from "esbuild";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, "../static");
const lucide = path.join(root, "node_modules/lucide-static");
const names =
  "box boxes package layers layout-grid list list-checks users settings-2 settings search plus arrow-left arrow-up-right arrow-right chevron-right chevron-down link upload file-box circle-check check x undo-2 history arrow-left-right move-3d rotate-cw mouse-pointer-2 crosshair maximize-2 minimize-2 image type trash-2 star pin sliders-horizontal moon sun monitor copy download lock circle-help keyboard command panel-right-close panel-right-open warehouse".split(
    " ",
  );
const symbols = [];
for (const name of names) {
  const svg = await readFile(path.join(lucide, "icons", name + ".svg"), "utf8");
  const body = svg.slice(
    svg.indexOf(">", svg.indexOf("<svg")) + 1,
    svg.indexOf("</svg>"),
  );
  symbols.push(`<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`);
}
await writeFile(
  path.join(output, "ui-icons.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg">' + symbols.join("") + "</svg>",
);
await copyFile(
  path.join(lucide, "LICENSE"),
  path.join(output, "lucide-LICENSE.txt"),
);
await writeFile(
  path.join(output, "ui-icons-source.json"),
  JSON.stringify(
    {
      package: "lucide-static",
      version: "0.468.0",
      source: "https://github.com/lucide-icons/lucide",
      license: "https://lucide.dev/license",
      icons: names,
    },
    null,
    2,
  ),
);
await copyFile(
  path.join(root, "node_modules/three/LICENSE"),
  path.join(output, "three-LICENSE.txt"),
);
await build({
  entryPoints: [path.join(root, "scene3d.js")],
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "linked",
  outfile: path.join(output, "chests3d.js"),
});

await build({
  entryPoints: [path.join(root, "schematic3d.js")],
  bundle: true, format: "esm", minify: true, legalComments: "linked",
  outfile: path.join(output, "schematic3d.js"),
});
