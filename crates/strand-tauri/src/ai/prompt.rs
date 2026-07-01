use strand_core::diff::{DiffStatus, FileDiff};

const MAX_FILES: usize = 8;
const MAX_TOTAL_CHARS: usize = 12_000;

const INSTRUCTION: &str = "Write a git commit message for the staged changes below.\n\
Use conventional commit style when appropriate.\n\
Reply with JSON only, no markdown fences: {\"subject\":\"...\",\"body\":\"...\"}\n\
Keep subject at most 72 characters. Body may be empty string if not needed.";

/// Build the user prompt sent to Codex / Claude from staged file diffs.
pub fn build_prompt(diffs: &[FileDiff]) -> String {
    let mut out = String::from(INSTRUCTION);
    out.push_str("\n\n## Staged changes\n");
    let mut budget = MAX_TOTAL_CHARS;

    for diff in diffs.iter().take(MAX_FILES) {
        if budget == 0 {
            out.push_str("\n… (additional files omitted)\n");
            break;
        }
        out.push_str(&format_file_header(diff));
        out.push('\n');

        if diff.binary {
            out.push_str("(binary file — patch omitted)\n\n");
            continue;
        }

        let patch = truncate_patch(&diff.patch, budget);
        budget = budget.saturating_sub(patch.len());
        out.push_str(&patch);
        if !patch.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }

    if diffs.len() > MAX_FILES {
        out.push_str(&format!(
            "\n… and {} more staged file(s) omitted\n",
            diffs.len() - MAX_FILES
        ));
    }

    out
}

fn format_file_header(diff: &FileDiff) -> String {
    let status = match diff.status {
        DiffStatus::Added => "added",
        DiffStatus::Modified => "modified",
        DiffStatus::Deleted => "deleted",
        DiffStatus::Renamed => "renamed",
        DiffStatus::Copied => "copied",
        DiffStatus::Typechange => "typechange",
    };
    match &diff.old_path {
        Some(old) if old != &diff.path => {
            format!(
                "### {} ({status}, +{} -{}, was {old})",
                diff.path, diff.adds, diff.dels
            )
        }
        _ => format!("### {} ({status}, +{} -{})", diff.path, diff.adds, diff.dels),
    }
}

fn truncate_patch(patch: &str, max: usize) -> String {
    if patch.len() <= max {
        return patch.to_string();
    }
    let mut out = patch.chars().take(max).collect::<String>();
    out.push_str("\n… (patch truncated)\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use strand_core::diff::DiffStatus;

    fn sample_diff(path: &str, patch: &str) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: DiffStatus::Modified,
            adds: 1,
            dels: 1,
            binary: false,
            patch: patch.into(),
        }
    }

    #[test]
    fn includes_instruction_and_file_header() {
        let prompt = build_prompt(&[sample_diff("src/a.rs", "+line\n-line")]);
        assert!(prompt.contains("JSON only"));
        assert!(prompt.contains("### src/a.rs"));
        assert!(prompt.contains("+line"));
    }

    #[test]
    fn binary_files_skip_patch() {
        let mut d = sample_diff("img.png", "should not appear");
        d.binary = true;
        let prompt = build_prompt(&[d]);
        assert!(prompt.contains("binary file"));
        assert!(!prompt.contains("should not appear"));
    }

    #[test]
    fn truncates_large_patch() {
        let big = "x".repeat(MAX_TOTAL_CHARS + 500);
        let prompt = build_prompt(&[sample_diff("big.txt", &big)]);
        assert!(prompt.contains("patch truncated"));
        assert!(prompt.len() < big.len());
    }
}
