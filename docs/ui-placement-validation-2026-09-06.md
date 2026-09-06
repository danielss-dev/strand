# UI placement and readability — September 6, 2026

Implemented the approved placement revision for today's feature PRs. PR #114's
performance work remains intact; occasional tools stay lazy and menu-driven.

## Placement inventory

| PR | Revised placement |
| --- | --- |
| #115 | Commit signing in Commit options; successful output in Activity history; identity/signing in Repository settings; tag signing under Advanced options and verification in the tag menu. |
| #116 | Git LFS in repository menus, with a selected-file pattern/lock entry point; Submodule actions offers Add, Update all and Manage, with row management submenus. |
| #117 | Clone options collapsed under Advanced options; history download under Fetch; checked-out folder selection in File actions; compact sparse-checkout link. |
| #118 | Saved actions directly in contextual Actions menus; a dedicated User actions settings page with one argument per input row. |
| #119 | Separate Import / Export commands; Git note and working/broken bisect entry points on commits; replacements under Advanced; editing under Edit tag; Git-flow under Branch actions; short resume banners. |
| #120 | Publish in Remote actions and the no-remotes empty state; custom provider selection in Edit URLs → Advanced; sign-in guidance in Hosting. |
| #121 | Review comparison/marking in Code; unresolved export in PR actions; Preview suggestion beside a suggestion; queue/automatic merging in Merge options; paging beside each section/thread and in the inbox footer. |
| #122 | SSH opening in repository + menus and Quick Launch; CLI installation under Integrations → Command line. |

## Readability and interaction checks

Reviewed the changed labels, explanatory text, status messages, menus and dialogs.
Replaced raw boolean values, ambiguous identity labels, generic action buttons,
unrelated tool selectors and implementation terminology. Technical Git details
remain where they explain a choice or operation. LFS tracking explicitly says
pattern because its existing backend accepts wildcard patterns, not literal files.

Used Chromium against Strand's demo entry with the actual React components and
Tauri mock IPC at 1280×800 and 880×600. Screenshots were inspected after animations
settled. QA-only fixtures supplied optional Git/hosting read results without
changing demo source or contacting hosting services. The demo font path was
redirected to its existing font assets in the browser harness.

Checked:

- Repository context menus with Shift+F10, submenu labels, Escape, and captured
  repository/ref targets; Branch, Remote, Submodule and repository + menus.
- Identity/signing tabs and advanced disclosures; long forms scroll while their
  headers/footers remain visible. Fixed clipped settings and signing footers and
  compressed Git-flow controls using the actual 96px backdrop offset.
- Clone, sparse checkout, history, patch/bundle import/export, Git notes,
  replacements, bisect, Git-flow, LFS, submodule, tag and SSH dialog entry points.
- Custom provider selection only appears when Advanced is expanded. Command
  line setup stays collapsed in Integrations.
- User-action editing preserves spaces, metacharacters and blank arguments as
  separate values. Saving a fixture action produced exactly the entered array.
- Ctrl+Enter committed only in the in-memory demo repository; successful output
  appeared in Activity history, and the commit form cleared its draft.
- PR export menu; Code review controls; exact thread/comment/suggestion preview
  request and Before/After fields; separate checks and thread-reply page reads.
- Queue options remain reachable while immediate merging is blocked; queue
  position and blockers are readable, and Escape restores Merge options focus.
  Queue state also remains inspectable without cancellation permission.
- Code's added actions wrap as whole controls at 880px; the toolbar uses 11px
  text and its measured scroll width equals its available width.

Screenshots and temporary build/test logs are local under
`target/ui-placement-qa/`; they are not source assets.

## Automated checks and limits

- Frontend TypeScript check and production build passed.
- 469 tests across 85 files passed, including repository-target regression
  checks and queue-control reachability with/without cancellation permission.
- `git diff --check` passed.
- An isolated native executable compiled successfully. Automatic approval review
  rejected starting it with the reason “blocked by policy.” The running user
  app and its Vite server were left alone. Native WebView2 integration is still
  unverified for this revision and is recorded as a follow-up in TASKS.md.
- Browser checks validate placement, wording, layout and frontend interaction.
  They do not establish real signing, SSH, provider mutation, filesystem-dialog
  or native-menu behavior. Existing backend guards were retained.
- The production build reports existing large-chunk/mixed-import warnings and
  pnpm reports the existing deprecated patchedDependencies configuration.
