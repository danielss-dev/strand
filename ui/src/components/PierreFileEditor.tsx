import { useMemo } from 'react';
import type { FileOptions } from '@pierre/diffs/react';
import { EditProvider, File } from '@pierre/diffs/react';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';

interface PierreFileEditorProps {
  cacheKey: string;
  options: FileOptions<undefined>;
  path: string;
  selectedLine: number | null;
  text: string;
  onChange(text: string): void;
}

function createEditor(options: EditorOptions<undefined>): Editor<undefined> {
  return new Editor<undefined>(options);
}

/** Lazy-loaded boundary around Pierre's experimental edit entry point. */
export default function PierreFileEditor({
  cacheKey,
  options,
  path,
  selectedLine,
  text,
  onChange,
}: PierreFileEditorProps) {
  const file = useMemo(() => ({ name: path, contents: text, cacheKey }), [cacheKey, path, text]);
  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({ onChange: (changed) => onChange(changed.contents) }),
    [onChange],
  );

  return (
    <EditProvider createEditor={createEditor}>
      <File
        file={file}
        options={options}
        edit
        editorOptions={editorOptions}
        selectedLines={selectedLine == null ? undefined : { start: selectedLine, end: selectedLine }}
      />
    </EditProvider>
  );
}
