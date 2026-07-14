use super::{CommitMessageSuggestion, PullRequestSuggestion};

const MAX_COMMIT_BODY_BYTES: usize = 65_536;
const MAX_DIAGNOSTIC_BYTES: usize = 2_048;

/// Extract `{ subject, body }` from CLI stdout — JSON object, fenced JSON, or
/// embedded JSON in prose.
pub fn parse_suggestion(raw: &str) -> Result<CommitMessageSuggestion, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("AI returned an empty response.".into());
    }

    if let Ok(v) = serde_json::from_str::<CommitMessageSuggestion>(trimmed) {
        return normalize(v);
    }

    if let Some(json) = extract_json_object(trimmed) {
        if let Ok(v) = serde_json::from_str::<CommitMessageSuggestion>(&json) {
            return normalize(v);
        }
    }

    if let Some(json) = extract_fenced_json(trimmed) {
        if let Ok(v) = serde_json::from_str::<CommitMessageSuggestion>(&json) {
            return normalize(v);
        }
    }

    Err(format!(
        "Could not parse commit message from AI output. Expected JSON with subject and body fields.\n\n{}",
        diagnostic_excerpt(trimmed)
    ))
}

/// Extract and normalize a PR title/description from provider output.
pub fn parse_pull_request_suggestion(raw: &str) -> Result<PullRequestSuggestion, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("AI returned an empty response.".into());
    }

    let parsed = serde_json::from_str::<PullRequestSuggestion>(trimmed)
        .ok()
        .or_else(|| {
            extract_json_object(trimmed)
                .and_then(|json| serde_json::from_str::<PullRequestSuggestion>(&json).ok())
        })
        .or_else(|| {
            extract_fenced_json(trimmed)
                .and_then(|json| serde_json::from_str::<PullRequestSuggestion>(&json).ok())
        })
        .ok_or_else(|| {
            format!(
                "Could not parse pull request content from AI output. Expected JSON with title and description fields.\n\n{}",
                diagnostic_excerpt(trimmed)
            )
        })?;
    normalize_pull_request(parsed)
}

fn normalize(mut s: CommitMessageSuggestion) -> Result<CommitMessageSuggestion, String> {
    s.subject = s.subject.trim().to_string();
    if s.subject.is_empty() {
        return Err("AI returned an empty subject.".into());
    }
    if truncate_utf8_bytes(&mut s.subject, 72) {
        s.subject = s.subject.trim_end().to_string();
    }
    s.body = s
        .body
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    if s.body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_COMMIT_BODY_BYTES)
    {
        return Err("AI returned a commit message body over Strand's 64 KB limit.".into());
    }
    Ok(s)
}

fn normalize_pull_request(
    mut suggestion: PullRequestSuggestion,
) -> Result<PullRequestSuggestion, String> {
    suggestion.title = suggestion.title.trim().to_string();
    truncate_utf8_bytes(&mut suggestion.title, 512);
    if suggestion.title.is_empty() {
        return Err("AI returned an empty pull request title.".into());
    }
    suggestion.description = suggestion.description.trim().to_string();
    if suggestion.description.len() > 65_536 {
        return Err("AI returned a pull request description over Strand's 64 KB limit.".into());
    }
    Ok(suggestion)
}

fn truncate_utf8_bytes(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    true
}

fn diagnostic_excerpt(value: &str) -> String {
    if value.len() <= MAX_DIAGNOSTIC_BYTES {
        return value.to_string();
    }
    let mut end = MAX_DIAGNOSTIC_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (output truncated)", &value[..end])
}

/// Find the first `{ ... }` object in text (brace-balanced, naive string skip).
fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_fenced_json(text: &str) -> Option<String> {
    for marker in ["```json", "```"] {
        if let Some(start) = text.find(marker) {
            let rest = &text[start + marker.len()..];
            if let Some(end) = rest.find("```") {
                return Some(rest[..end].trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json() {
        let s = parse_suggestion(r#"{"subject":"fix: auth","body":"Handle edge case"}"#).unwrap();
        assert_eq!(s.subject, "fix: auth");
        assert_eq!(s.body.as_deref(), Some("Handle edge case"));
    }

    #[test]
    fn parses_json_in_prose() {
        let raw = "Here is the message:\n{\"subject\":\"feat: add x\",\"body\":\"\"}\nDone.";
        let s = parse_suggestion(raw).unwrap();
        assert_eq!(s.subject, "feat: add x");
        assert!(s.body.is_none());
    }

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"subject\":\"chore: deps\",\"body\":\"Bump versions\"}\n```";
        let s = parse_suggestion(raw).unwrap();
        assert_eq!(s.subject, "chore: deps");
    }

    #[test]
    fn truncates_long_subject() {
        let long = "x".repeat(100);
        let raw = format!(r#"{{"subject":"{long}","body":null}}"#);
        let s = parse_suggestion(&raw).unwrap();
        assert!(s.subject.len() <= 72);
    }

    #[test]
    fn rejects_oversized_commit_body() {
        let raw = serde_json::json!({ "subject": "fix: bounded", "body": "x".repeat(MAX_COMMIT_BODY_BYTES + 1) }).to_string();
        assert!(parse_suggestion(&raw).unwrap_err().contains("64 KB"));
    }

    #[test]
    fn caps_parse_diagnostics_on_utf8_boundaries() {
        let err = parse_suggestion(&"é".repeat(MAX_DIAGNOSTIC_BYTES)).unwrap_err();
        assert!(err.contains("output truncated"));
        assert!(err.len() < MAX_DIAGNOSTIC_BYTES + 256);
    }

    #[test]
    fn parses_pull_request_json_in_prose() {
        let raw = "Draft:\n{\"title\":\" Add PR creation \",\"description\":\"## Summary\\n\\n- Add dialog\"}\nDone.";
        let suggestion = parse_pull_request_suggestion(raw).unwrap();
        assert_eq!(suggestion.title, "Add PR creation");
        assert!(suggestion.description.contains("Add dialog"));
    }

    #[test]
    fn rejects_empty_pull_request_title() {
        let raw = r#"{"title":" ","description":"Details"}"#;
        assert!(parse_pull_request_suggestion(raw).is_err());
    }

    #[test]
    fn truncates_pull_request_title_on_a_utf8_boundary() {
        let raw = serde_json::json!({
            "title": "é".repeat(300),
            "description": "Details"
        })
        .to_string();
        let suggestion = parse_pull_request_suggestion(&raw).unwrap();
        assert!(suggestion.title.len() <= 512);
        assert!(suggestion.title.is_char_boundary(suggestion.title.len()));
    }
}
