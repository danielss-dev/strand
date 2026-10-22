//! Conflict-marker parse shared with `ui/src/lib/conflictParse.ts`.
//!
//! A diff3 `|||||||` section is kept as base text. When that section is
//! absent, `base` is `None` and the prompt says the base is unavailable.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictHunk {
    pub ours: String,
    pub theirs: String,
    pub base: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedConflictText {
    pub hunks: Vec<ConflictHunk>,
    pub ours_label: String,
    pub theirs_label: String,
}

pub fn parse_conflict_text(text: &str) -> ParsedConflictText {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut hunks = Vec::new();
    let mut ours_label = "HEAD".to_string();
    let mut theirs_label = "incoming".to_string();
    let mut i = 0;
    while i < lines.len() {
        if !is_start(lines[i]) {
            i += 1;
            continue;
        }
        if let Some(label) = marker_label(lines[i]) {
            ours_label = label;
        }
        i += 1;

        let mut ours = Vec::new();
        while i < lines.len() && !is_base(lines[i]) && !is_sep(lines[i]) && !is_end(lines[i]) {
            ours.push(lines[i]);
            i += 1;
        }

        let base = if i < lines.len() && is_base(lines[i]) {
            i += 1;
            let mut base_lines = Vec::new();
            while i < lines.len() && !is_sep(lines[i]) && !is_end(lines[i]) {
                base_lines.push(lines[i]);
                i += 1;
            }
            Some(base_lines.join("\n"))
        } else {
            None
        };

        if i < lines.len() && is_sep(lines[i]) {
            i += 1;
        }

        let mut theirs = Vec::new();
        while i < lines.len() && !is_end(lines[i]) {
            theirs.push(lines[i]);
            i += 1;
        }
        if i < lines.len() && is_end(lines[i]) {
            if let Some(label) = marker_label(lines[i]) {
                theirs_label = label;
            }
            i += 1;
        }

        hunks.push(ConflictHunk {
            ours: ours.join("\n"),
            theirs: theirs.join("\n"),
            base,
        });
    }

    ParsedConflictText {
        hunks,
        ours_label,
        theirs_label,
    }
}

fn is_start(line: &str) -> bool {
    line.starts_with("<<<<<<<")
}
fn is_base(line: &str) -> bool {
    line.starts_with("|||||||")
}
fn is_sep(line: &str) -> bool {
    line.starts_with("=======")
}
fn is_end(line: &str) -> bool {
    line.starts_with(">>>>>>>")
}

fn marker_label(line: &str) -> Option<String> {
    let label = line.get(7..).unwrap_or("").trim();
    (!label.is_empty()).then(|| label.to_string())
}

/// True when `text` still holds a line git writes to open or close a
/// conflict: exactly seven `<` or `>`, then end of line or whitespace and a
/// label. Mirrors `hasConflictMarkers` in `ui/src/lib/conflictAi.ts`. A lone
/// `=======` (Markdown/RST setext underline) or a longer run is ordinary text;
/// `=======` and `|||||||` only mean something between those lines.
pub fn contains_conflict_marker(text: &str) -> bool {
    text.split('\n').any(|line| {
        let line = line.trim_end_matches('\r');
        ["<<<<<<<", ">>>>>>>"].iter().any(|marker| {
            line.strip_prefix(marker)
                .is_some_and(|rest| rest.chars().next().is_none_or(char::is_whitespace))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIXED: &str = concat!(
        "fn greet(name: &str) -> String {\n",
        "<<<<<<< HEAD\n",
        "    format!(\"hello {name}\")\n",
        "||||||| base\n",
        "    format!(\"hi {name}\")\n",
        "=======\n",
        "    format!(\"hey {name}\")\n",
        ">>>>>>> feature\n",
        "}\n",
        "\n",
        "<<<<<<< HEAD\n",
        "fn helper() {}\n",
        "=======\n",
        "fn renamed_helper() {}\n",
        ">>>>>>> feature",
    );

    #[test]
    fn only_opening_and_closing_lines_count_as_leftover_markers() {
        assert!(contains_conflict_marker("<<<<<<< HEAD\nours"));
        assert!(contains_conflict_marker("a\n>>>>>>> feature"));
        assert!(contains_conflict_marker("a\n<<<<<<<\r\nb"));
        assert!(!contains_conflict_marker("Title\n=======\n\nBody"));
        assert!(!contains_conflict_marker("Title\n=========="));
        assert!(!contains_conflict_marker("<<<<<<<<<< not a marker\n|||||||"));
    }

    #[test]
    fn mixed_fixture_keeps_base_only_where_diff3_is_present() {
        let parsed = parse_conflict_text(MIXED);
        assert_eq!(parsed.hunks.len(), 2);
        assert_eq!(parsed.hunks[0].ours, "    format!(\"hello {name}\")");
        assert_eq!(parsed.hunks[0].base.as_deref(), Some("    format!(\"hi {name}\")"));
        assert_eq!(parsed.hunks[0].theirs, "    format!(\"hey {name}\")");
        assert_eq!(parsed.hunks[1].ours, "fn helper() {}");
        assert!(parsed.hunks[1].base.is_none());
        assert_eq!(parsed.hunks[1].theirs, "fn renamed_helper() {}");
        assert_eq!(parsed.ours_label, "HEAD");
        assert_eq!(parsed.theirs_label, "feature");
    }
}
