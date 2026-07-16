import { describe, expect, it } from 'vitest';

import { resolveTreeFileIcon, TREE_ICONS } from './treeIcons';

describe('TREE_ICONS', () => {
  it('adds real file-type icons missing from Pierre while retaining its complete set', () => {
    expect(TREE_ICONS.set).toBe('complete');
    expect(TREE_ICONS.byFileName).toMatchObject({
      'CMakeLists.txt': 'strand-tree-material-cmake',
    });
    expect(TREE_ICONS.byFileExtension).toMatchObject({
      cs: 'strand-tree-material-csharp',
      razor: 'strand-tree-material-razor',
      fs: 'strand-tree-material-fsharp',
      vb: 'strand-tree-material-visual-basic',
      java: 'strand-tree-material-java',
      kt: 'strand-tree-material-kotlin',
      php: 'strand-tree-material-php',
      gradle: 'strand-tree-material-gradle',
      xml: 'strand-tree-material-xml',
    });
  });

  it('defines a sprite symbol for every configured file rule', () => {
    const spriteSheet = TREE_ICONS.spriteSheet ?? '';
    const configuredIcons = [
      ...Object.values(TREE_ICONS.byFileName ?? {}),
      ...Object.values(TREE_ICONS.byFileExtension ?? {}),
    ];

    for (const icon of configuredIcons) {
      const name = typeof icon === 'string' ? icon : icon.name;
      expect(spriteSheet).toContain(`id="${name}"`);
    }
  });

  it('uses vector logos rather than text badges', () => {
    const spriteSheet = TREE_ICONS.spriteSheet ?? '';
    const symbol = (name: string) => (
      spriteSheet.match(new RegExp(`<symbol id="${name}"[\\s\\S]*?</symbol>`))?.[0]
    );

    expect(spriteSheet).toContain('<path');
    expect(spriteSheet).toContain('strand-tree-material-kotlin-a');
    expect(spriteSheet).not.toContain('<text');
    expect(symbol('strand-tree-material-csharp')).toContain('#0288d1');
    expect(symbol('strand-tree-material-java')).toContain('#f44336');
  });

  it('resolves non-tree file rows through the same built-in and custom rules', () => {
    expect(resolveTreeFileIcon('src/perfcheck.rs')).toMatchObject({
      name: 'file-tree-builtin-rust',
      token: 'rust',
    });
    expect(resolveTreeFileIcon('src/App.cs')).toMatchObject({
      name: 'strand-tree-material-csharp',
    });
  });
});
