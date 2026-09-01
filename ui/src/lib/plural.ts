/** `"1 file"` / `"3 files"` — English count + noun, no extra punctuation. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
