use clap::{Parser, Subcommand};
use std::io::{self, Write};
use strand_ops::{DiffSource, OpError, ReadOp, ReadRequest, ReadResult, Result};

#[derive(Parser)]
#[command(
    name = "strand",
    version,
    about = "Open Strand or read a repository without changing it",
    subcommand_precedence_over_arg = true
)]
struct Cli {
    /// Repository discovery starts here; defaults to the current directory.
    #[arg(short = 'C', global = true)]
    directory: Option<String>,
    /// Versioned JSON on stdout; a single JSON error on stderr on failure.
    #[arg(long, global = true)]
    json: bool,
    /// Open the repository in the desktop. Use -- PATH for command-like names.
    path: Option<String>,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Working-tree/index status, optionally with metadata, refs and files.
    Status {
        #[arg(long)]
        snapshot: bool,
    },
    /// Recent history (all refs by default), or rename-following file history.
    Log {
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        head: bool,
        #[arg(long)]
        file: Option<String>,
    },
    /// Unified patches. Whole-file context is available for unstaged/since.
    Diff {
        #[arg(long, group = "source")]
        staged: bool,
        #[arg(long, group = "source")]
        commit: Option<String>,
        #[arg(long, num_args = 2, group = "source")]
        between: Vec<String>,
        #[arg(long, group = "source")]
        since: Option<String>,
        #[arg(long)]
        full_context: bool,
    },
    /// Full-context changes since a base, recent HEAD history and status.
    Review {
        #[arg(long, default_value = "HEAD")]
        since: String,
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
    },
    /// JSON schemas for the versioned output, request and error types.
    Schema,
}

pub fn run(args: Vec<String>) -> Result<()> {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            return output(error.to_string().as_bytes());
        }
        Err(error) => return Err(OpError::new("invalid_request", error.to_string())),
    };
    if cli.path.is_some() && cli.command.is_some() {
        return Err(OpError::new(
            "invalid_request",
            "Choose a path to open or a read command, not both.",
        ));
    }
    let Some(action) = cli.command else {
        let path = cli.path.ok_or_else(|| {
            OpError::new(
                "invalid_request",
                "Pass a repository path or a read command; see strand --help.",
            )
        })?;
        let path = if let Some(directory) = cli.directory {
            std::path::Path::new(&directory)
                .join(path)
                .to_string_lossy()
                .into_owned()
        } else {
            path
        };
        crate::launcher::launch(&["--".into(), path])
            .map_err(|e| OpError::new("invalid_request", e))?;
        if cli.json {
            output(b"{\"schemaVersion\":1,\"launched\":true}\n")?;
        }
        return Ok(());
    };
    let op = match action {
        Action::Schema => return output(&strand_ops::encode(&strand_ops::schema())?),
        Action::Status { snapshot: false } => ReadOp::Status {},
        Action::Status { snapshot: true } => ReadOp::Snapshot {},
        Action::Log { limit, head, file } => match file {
            Some(path) => ReadOp::FileHistory { path, limit },
            None => ReadOp::Log {
                limit,
                head_only: head,
            },
        },
        Action::Review { since, limit } => ReadOp::Review { since, limit },
        Action::Diff {
            staged,
            commit,
            between,
            since,
            full_context,
        } => {
            if full_context && (staged || commit.is_some() || !between.is_empty()) {
                return Err(OpError::new(
                    "invalid_request",
                    "--full-context is supported for unstaged diffs and --since only.",
                ));
            }
            let source = if staged {
                DiffSource::Staged {}
            } else if let Some(revision) = commit {
                DiffSource::Commit { revision }
            } else if between.len() == 2 {
                DiffSource::Between {
                    from: between[0].clone(),
                    to: between[1].clone(),
                }
            } else if let Some(revision) = since {
                DiffSource::Since {
                    revision,
                    full_context,
                }
            } else {
                DiffSource::Unstaged { full_context }
            };
            ReadOp::Diff { source }
        }
    };
    let envelope = strand_ops::execute(&ReadRequest {
        repository: cli.directory.unwrap_or_else(|| ".".into()),
        op,
    })?;
    // Enforce the same bound before printing any bytes, including human output.
    let encoded = strand_ops::encode(&envelope)?;
    if cli.json {
        output(&encoded)
    } else {
        let text = human(&envelope.result);
        if text.len() >= strand_ops::MAX_FRAME_BYTES {
            return Err(OpError::new(
                "output_limit",
                "Human output exceeds 8 MiB; narrow the request.",
            ));
        }
        output(text.as_bytes())
    }
}

fn output(bytes: &[u8]) -> Result<()> {
    match io::stdout().lock().write_all(bytes) {
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(OpError::new("io", error.to_string())),
        Ok(()) => Ok(()),
    }
}

fn human(result: &ReadResult) -> String {
    let value = match result {
        ReadResult::Status(files) => {
            if files.is_empty() {
                "Working tree clean\n".into()
            } else {
                files
                    .iter()
                    .map(|f| {
                        format!(
                            "{} {:10?} {}\n",
                            if f.staged { "index" } else { "work " },
                            f.kind,
                            f.path
                        )
                    })
                    .collect()
            }
        }
        ReadResult::Log(commits) => commits
            .iter()
            .map(|c| format!("{} {} — {}\n", c.short_hash, c.subject, c.author_name))
            .collect(),
        ReadResult::FileHistory(commits) => commits
            .iter()
            .map(|c| format!("{} {} (+{} -{})\n", c.short_hash, c.subject, c.adds, c.dels))
            .collect(),
        ReadResult::Diff(files) => files
            .iter()
            .map(|f| {
                if f.binary {
                    format!("Binary file: {}\n", f.path)
                } else {
                    f.patch.clone()
                }
            })
            .collect(),
        ReadResult::Review(review) => format!(
            "Review since {}\n\n{}\n{}",
            review.base,
            human(&ReadResult::Status(review.status.clone())),
            human(&ReadResult::Diff(review.diffs.clone()))
        ),
        ReadResult::Snapshot(snapshot) => format!(
            "{} · {} · {} ahead / {} behind\n{}",
            snapshot.meta.name,
            snapshot.meta.branch,
            snapshot.meta.ahead,
            snapshot.meta.behind,
            human(&ReadResult::Status(snapshot.status.clone()))
        ),
        _ => serde_json::to_string_pretty(result).unwrap_or_default() + "\n",
    };
    // Repository-controlled strings must not execute terminal escape sequences.
    let mut safe = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            safe.extend(c.escape_default());
        } else {
            safe.push(c);
        }
    }
    safe
}
