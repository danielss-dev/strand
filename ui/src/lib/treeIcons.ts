import type { FileTreeIconConfig } from '@pierre/trees';

import assemblySvg from 'material-icon-theme/icons/assembly.svg?raw';
import clojureSvg from 'material-icon-theme/icons/clojure.svg?raw';
import cmakeSvg from 'material-icon-theme/icons/cmake.svg?raw';
import cobolSvg from 'material-icon-theme/icons/cobol.svg?raw';
import crystalSvg from 'material-icon-theme/icons/crystal.svg?raw';
import csharpSvg from 'material-icon-theme/icons/csharp.svg?raw';
import dartSvg from 'material-icon-theme/icons/dart.svg?raw';
import elixirSvg from 'material-icon-theme/icons/elixir.svg?raw';
import erlangSvg from 'material-icon-theme/icons/erlang.svg?raw';
import fortranSvg from 'material-icon-theme/icons/fortran.svg?raw';
import fsharpSvg from 'material-icon-theme/icons/fsharp.svg?raw';
import gradleSvg from 'material-icon-theme/icons/gradle.svg?raw';
import groovySvg from 'material-icon-theme/icons/groovy.svg?raw';
import haskellSvg from 'material-icon-theme/icons/haskell.svg?raw';
import javaSvg from 'material-icon-theme/icons/java.svg?raw';
import juliaSvg from 'material-icon-theme/icons/julia.svg?raw';
import kotlinSvg from 'material-icon-theme/icons/kotlin.svg?raw';
import luaSvg from 'material-icon-theme/icons/lua.svg?raw';
import nimSvg from 'material-icon-theme/icons/nim.svg?raw';
import ocamlSvg from 'material-icon-theme/icons/ocaml.svg?raw';
import perlSvg from 'material-icon-theme/icons/perl.svg?raw';
import phpSvg from 'material-icon-theme/icons/php.svg?raw';
import powershellSvg from 'material-icon-theme/icons/powershell.svg?raw';
import rSvg from 'material-icon-theme/icons/r.svg?raw';
import razorSvg from 'material-icon-theme/icons/razor.svg?raw';
import scalaSvg from 'material-icon-theme/icons/scala.svg?raw';
import soliditySvg from 'material-icon-theme/icons/solidity.svg?raw';
import visualStudioSvg from 'material-icon-theme/icons/visualstudio.svg?raw';
import xmlSvg from 'material-icon-theme/icons/xml.svg?raw';

interface MaterialFileIcon {
  id: string;
  source: string;
  extensions: readonly string[];
}

/**
 * Real file-type marks not covered by Pierre's built-in `complete` set.
 * Selected from Material Icon Theme (MIT), pinned in package.json.
 */
const MATERIAL_FILE_ICONS: readonly MaterialFileIcon[] = [
  { id: 'csharp', source: csharpSvg, extensions: ['cs', 'csx'] },
  { id: 'razor', source: razorSvg, extensions: ['cshtml', 'razor'] },
  { id: 'fsharp', source: fsharpSvg, extensions: ['fs', 'fsi', 'fsx', 'fsscript'] },
  { id: 'visual-basic', source: visualStudioSvg, extensions: ['vb', 'vbs'] },
  { id: 'java', source: javaSvg, extensions: ['java', 'jsp'] },
  { id: 'kotlin', source: kotlinSvg, extensions: ['kt', 'kts'] },
  { id: 'scala', source: scalaSvg, extensions: ['scala', 'sc'] },
  { id: 'php', source: phpSvg, extensions: ['php', 'phtml'] },
  { id: 'dart', source: dartSvg, extensions: ['dart'] },
  { id: 'lua', source: luaSvg, extensions: ['lua'] },
  { id: 'r', source: rSvg, extensions: ['r', 'rmd'] },
  { id: 'julia', source: juliaSvg, extensions: ['jl'] },
  { id: 'haskell', source: haskellSvg, extensions: ['hs', 'lhs'] },
  { id: 'elixir', source: elixirSvg, extensions: ['ex', 'exs', 'eex', 'heex', 'leex'] },
  { id: 'erlang', source: erlangSvg, extensions: ['erl', 'hrl'] },
  { id: 'clojure', source: clojureSvg, extensions: ['clj', 'cljs', 'cljc', 'edn'] },
  { id: 'groovy', source: groovySvg, extensions: ['groovy', 'gvy', 'gy', 'gyd'] },
  { id: 'gradle', source: gradleSvg, extensions: ['gradle'] },
  { id: 'perl', source: perlSvg, extensions: ['pl', 'pm'] },
  { id: 'ocaml', source: ocamlSvg, extensions: ['ml', 'mli'] },
  { id: 'solidity', source: soliditySvg, extensions: ['sol'] },
  { id: 'assembly', source: assemblySvg, extensions: ['asm', 's'] },
  { id: 'nim', source: nimSvg, extensions: ['nim', 'nims'] },
  { id: 'crystal', source: crystalSvg, extensions: ['cr'] },
  {
    id: 'fortran',
    source: fortranSvg,
    extensions: ['f', 'f90', 'f95', 'f03', 'f08', 'for', 'ftn'],
  },
  { id: 'cobol', source: cobolSvg, extensions: ['cob', 'cbl', 'cpy'] },
  { id: 'powershell', source: powershellSvg, extensions: ['ps1', 'psm1', 'psd1'] },
  { id: 'cmake', source: cmakeSvg, extensions: ['cmake'] },
  { id: 'xml', source: xmlSvg, extensions: ['xml', 'xsd', 'xsl', 'xslt', 'xaml', 'plist'] },
];

const symbolName = (id: string) => `strand-tree-material-${id}`;

/** Convert one Material Icon Theme SVG into a namespaced Pierre sprite symbol. */
const materialSymbol = ({ id, source }: MaterialFileIcon): string => {
  const name = symbolName(id);
  const namespacedSource = source
    .replace(/\bid="([^"]+)"/g, (_, sourceId: string) => `id="${name}-${sourceId}"`)
    .replace(/url\(#([^)]+)\)/g, (_, sourceId: string) => `url(#${name}-${sourceId})`)
    .replace(/((?:xlink:)?href)="#([^"]+)"/g, (_, attribute: string, sourceId: string) => (
      `${attribute}="#${name}-${sourceId}"`
    ));

  return namespacedSource
    .replace(/^<svg\b/, `<symbol id="${name}"`)
    .replace(/<\/svg>\s*$/, '</symbol>');
};

const MATERIAL_SPRITE_SHEET = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  ${MATERIAL_FILE_ICONS.map(materialSymbol).join('\n  ')}
</svg>`;

const MATERIAL_ICONS_BY_EXTENSION = Object.fromEntries(
  MATERIAL_FILE_ICONS.flatMap(({ id, extensions }) => (
    extensions.map((extension) => [extension, symbolName(id)])
  )),
);

/** Pierre's complete icon set plus selected Material Icon Theme file marks. */
export const TREE_ICONS: FileTreeIconConfig = {
  set: 'complete',
  colored: true,
  spriteSheet: MATERIAL_SPRITE_SHEET,
  byFileName: {
    'CMakeLists.txt': symbolName('cmake'),
  },
  byFileExtension: MATERIAL_ICONS_BY_EXTENSION,
};
