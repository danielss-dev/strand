use super::CommitMessageSuggestion;

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
        "Could not parse commit message from AI output. Expected JSON with subject and body fields.\n\n{trimmed}"
    ))
}

fn normalize(mut s: CommitMessageSuggestion) -> Result<CommitMessageSuggestion, String> {
    s.subject = s.subject.trim().to_string();
    if s.subject.is_empty() {
        return Err("AI returned an empty subject.".into());
    }
    if s.subject.len() > 72 {
        s.subject.truncate(72);
        s.subject = s.subject.trim_end().to_string();
    }
    s.body = s
        .body
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    Ok(s)
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
}
