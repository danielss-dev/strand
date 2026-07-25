# Privacy Policy

Effective 24 July 2026

Strand is a local-first desktop Git client operated by Daniel Schwarz. This
notice explains what Strand handles, what leaves your computer, and which
choices remain yours.

## The short version

Strand has no product telemetry, advertising, analytics SDK, Strand account, or
automatic crash upload. Repository data and settings stay on your device unless
you deliberately use a network action or share a report.

## Data stored on your device

Strand stores the information needed to restore and operate your workspace,
including recently opened repository paths, workspaces, tabs, view preferences,
application settings, provider profile metadata, and local crash logs.
Repository files and Git metadata remain in the repositories you open.

Azure DevOps Server personal access tokens that Strand owns are stored in the
operating system's protected credential vault: Windows Credential Manager,
macOS Keychain, or Linux Secret Service. Strand does not write those tokens to
its settings database. Credentials owned by Git, GitHub CLI, Azure CLI, OpenAI
Codex CLI, or Claude Code remain under those tools' own storage and policies.

Deleting Strand's application data removes Strand's saved settings and session
metadata. It does not delete your Git repositories or credentials owned by
other tools.

## When data leaves your device

Strand makes a network request only for a feature that needs one:

- Git fetch, pull, push, and clone use system Git and the remote you selected.
- GitHub and Azure DevOps features contact those providers through your
  configured command-line tools or the optional signed Azure DevOps Server
  helper.
- Update checks contact Strand's signed stable release channel on GitHub
  Releases. Installing the optional Azure DevOps Server helper also downloads
  its signed release from GitHub.
- AI writing features run only when you ask for them. Strand sends the bounded
  prompt and repository context to the OpenAI Codex CLI or Claude Code CLI you
  selected, under your account with that provider. Strand does not retain or
  receive a copy through a Strand service.
- Opening external links, including repository hosts and documentation, sends
  the normal request to that site in your browser.

Those services process data under their own privacy policies. Strand does not
sell personal information and does not operate a server that receives your
repository content.

## Crash reports

Crash logs are written locally and can include application diagnostics and
repository paths. Crash reporting is off by default. If you enable the offer or
choose **Report last crash…**, Strand opens a pre-filled GitHub issue in your
browser. You can inspect, edit, or abandon it before anything is submitted.
Strand never uploads a crash report automatically.

## Website

The Strand website does not set analytics or advertising cookies. Its hosting
provider may process ordinary request information such as IP address, browser
details, requested path, and timestamp to deliver and protect the site.

## Children

Strand is a developer tool and is not directed to children. It does not
knowingly collect children's personal information.

## Changes and contact

Material changes to this notice will be published on this page with a new
effective date. Questions or privacy requests can be opened at
[github.com/danielss-dev/strand/issues](https://github.com/danielss-dev/strand/issues).
