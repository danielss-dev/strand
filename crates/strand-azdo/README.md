# strand-azdo

`strand-azdo` is Strand's optional Azure DevOps Server 2020+ REST helper. It is
not a general replacement for Azure CLI and is not installed on `PATH` by
Strand. The desktop app downloads the latest signed helper from its compiled
protocol channel only after the integration is enabled in Settings → Hosting.
Helper versions advance independently from Strand versions; a breaking IPC
change creates a new protocol channel instead of replacing an older one.

Maintainers bump this crate with `pnpm version:azdo patch` (or an explicit
version) and publish the printed `strand-azdo-vX.Y.Z` tag. Release metadata is
derived from each built binary's `version --json`, never duplicated by hand.

The human CLI stores profiles in the platform application-configuration
directory and PATs in Keychain, Windows Credential Manager, or Linux Secret
Service. PATs require HTTPS and at least Azure **Code: Read & write** scope.
Pass a PAT through stdin or use the hidden prompt; never place it in argv or an
environment variable.

```text
strand-azdo version --json
strand-azdo profile upsert                 # ServerProfile JSON on stdin
strand-azdo profile list
strand-azdo profile import-ca PROFILE PEM
strand-azdo auth set PROFILE               # PAT on stdin
strand-azdo auth login PROFILE             # hidden terminal prompt
strand-azdo auth status PROFILE
strand-azdo pr viewer PROFILE
strand-azdo pr list PROFILE PROJECT REPOSITORY [SOURCE_BRANCH]
strand-azdo pr show PROFILE PROJECT REPOSITORY PR
strand-azdo pr threads PROFILE PROJECT REPOSITORY PR
strand-azdo pr commits PROFILE PROJECT REPOSITORY PR
strand-azdo pr policies PROFILE PROJECT PROJECT_ID PR
strand-azdo pr comment PROFILE PROJECT REPOSITORY PR    # body on stdin
strand-azdo pr ready PROFILE PROJECT REPOSITORY PR
strand-azdo pr complete PROFILE PROJECT REPOSITORY PR EXPECTED_HEAD merge_commit|squash|rebase
strand-azdo pr create PROFILE PROJECT REPOSITORY SOURCE TARGET TITLE true|false # description on stdin
```

Machine integration uses `strand-azdo rpc`: one strict request envelope on
stdin and one response envelope on stdout. Protocol types and stable error
codes live in `strand-azdo-protocol`.

Windows-auth profiles use the current Windows identity through WinHTTP,
preferring Negotiate and falling back to NTLM. They use the Windows trusted-root
store. Imported PEM roots apply only to PAT profiles. Authenticated requests
never follow redirects.

If PAT authentication returns 401, verify the PAT's scope and expiry. Azure
DevOps Server PAT authentication also requires IIS Basic Authentication to be
disabled.
