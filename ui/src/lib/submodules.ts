export const SUBMODULE_ACTIONS = [
  ['inspect', 'Inspect working-tree status'],
  ['add', 'Add submodule'],
  ['update', 'Initialize / update submodule'],
  ['update-all', 'Initialize / update all submodules'],
  ['sync', 'Sync configured URLs'],
  ['set-url', 'Change submodule URL'],
  ['deinit', 'Deinitialize submodule'],
  ['remove', 'Remove submodule'],
] as const;
export type SubmoduleDialogAction = typeof SUBMODULE_ACTIONS[number][0];
