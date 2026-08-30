use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::rpc::{NdjsonRpc, RpcKind};
use super::HeroiProvider;
use crate::ai::bin::{resolve_claude, resolve_codex, resolve_cursor, run_capture};

const CLAUDE_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const CODEX_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CURSOR_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

const MINIMUM_CLAUDE_OPUS_5: (u32, u32, u32) = (2, 1, 219);
const MINIMUM_CLAUDE_FABLE_5: (u32, u32, u32) = (2, 1, 169);
const MINIMUM_CLAUDE_OPUS_4_8: (u32, u32, u32) = (2, 1, 154);
const MINIMUM_CLAUDE_OPUS_4_7: (u32, u32, u32) = (2, 1, 111);

const PREFERRED_CODEX_DEFAULTS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeroiReasoningOption {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeroiModel {
    pub slug: String,
    pub name: String,
    pub is_default: bool,
    pub reasoning: Vec<HeroiReasoningOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeroiModelCatalog {
    pub provider: HeroiProvider,
    pub models: Vec<HeroiModel>,
}

pub fn list_models(provider: HeroiProvider, cli_path: Option<&str>) -> HeroiModelCatalog {
    let models = match provider {
        HeroiProvider::Claude => claude_models(cli_path),
        HeroiProvider::Codex => codex_models(cli_path),
        HeroiProvider::Cursor => cursor_models(),
    };
    HeroiModelCatalog { provider, models }
}

pub fn canonicalize_model(provider: HeroiProvider, model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        return trimmed.to_string();
    }
    let aliases = match provider {
        HeroiProvider::Claude => CLAUDE_ALIASES,
        HeroiProvider::Codex => CODEX_ALIASES,
        HeroiProvider::Cursor => CURSOR_ALIASES,
    };
    aliases
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(trimmed))
        .map(|(_, slug)| (*slug).to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

pub fn normalize_claude_cli_effort(effort: &str, model: Option<&str>) -> Option<String> {
    match effort {
        "ultrathink" => None,
        "ultracode" => Some("xhigh".into()),
        "xhigh"
            if !matches!(
                model,
                Some("claude-fable-5" | "claude-opus-5" | "claude-opus-4-8" | "claude-sonnet-5")
            ) =>
        {
            Some("max".into())
        }
        "max" if model == Some("claude-sonnet-4-6") => Some("high".into()),
        other => Some(other.to_string()),
    }
}

pub fn apply_claude_prompt_effort(text: &str, effort: Option<&str>) -> String {
    let trimmed = text.trim();
    if effort != Some("ultrathink") || trimmed.is_empty() {
        return trimmed.to_string();
    }
    if trimmed.starts_with("Ultrathink:") || looks_like_slash_command(trimmed) {
        return trimmed.to_string();
    }
    format!("Ultrathink:\n{trimmed}")
}

fn looks_like_slash_command(text: &str) -> bool {
    text.starts_with('/') && !text[1..].contains('/') && !text[1..].is_empty()
}

fn claude_models(cli_path: Option<&str>) -> Vec<HeroiModel> {
    let version = resolve_claude(cli_path)
        .and_then(|bin| run_capture(&bin, &["--version"], None, None, CLAUDE_PROBE_TIMEOUT).ok())
        .as_deref()
        .and_then(parse_semver);
    claude_catalog(version)
}

fn claude_catalog(version: Option<(u32, u32, u32)>) -> Vec<HeroiModel> {
    let opus_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", true),
        ("xhigh", "Extra High", false),
        ("max", "Max", false),
        ("ultracode", "Ultracode", false),
        ("ultrathink", "Ultrathink", false),
    ]);
    let opus_47_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", false),
        ("xhigh", "Extra High", true),
        ("max", "Max", false),
        ("ultrathink", "Ultrathink", false),
    ]);
    let opus_46_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", true),
        ("max", "Max", false),
        ("ultrathink", "Ultrathink", false),
    ]);
    let opus_45_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", true),
        ("max", "Max", false),
    ]);
    let sonnet_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", true),
        ("xhigh", "Extra High", false),
        ("max", "Max", false),
        ("ultrathink", "Ultrathink", false),
    ]);
    let sonnet_46_effort = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", false),
        ("high", "High", true),
        ("max", "Max", false),
        ("ultrathink", "Ultrathink", false),
    ]);

    let mut models = Vec::new();
    if version_at_least(version, MINIMUM_CLAUDE_FABLE_5) {
        models.push(model(
            "claude-fable-5",
            "Claude Fable 5",
            false,
            opus_effort.clone(),
        ));
    }
    if version_at_least(version, MINIMUM_CLAUDE_OPUS_5) {
        models.push(model(
            "claude-opus-5",
            "Claude Opus 5",
            false,
            opus_effort.clone(),
        ));
    }
    if version_at_least(version, MINIMUM_CLAUDE_OPUS_4_8) {
        models.push(model(
            "claude-opus-4-8",
            "Claude Opus 4.8",
            false,
            opus_effort,
        ));
    }
    if version_at_least(version, MINIMUM_CLAUDE_OPUS_4_7) {
        models.push(model(
            "claude-opus-4-7",
            "Claude Opus 4.7",
            false,
            opus_47_effort,
        ));
    }
    models.extend([
        model("claude-opus-4-6", "Claude Opus 4.6", false, opus_46_effort),
        model("claude-opus-4-5", "Claude Opus 4.5", false, opus_45_effort),
        model("claude-sonnet-5", "Claude Sonnet 5", true, sonnet_effort),
        model(
            "claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            false,
            sonnet_46_effort,
        ),
        model("claude-haiku-4-5", "Claude Haiku 4.5", false, Vec::new()),
    ]);
    models
}

fn codex_models(cli_path: Option<&str>) -> Vec<HeroiModel> {
    probe_codex_models(cli_path).unwrap_or_else(codex_fallback)
}

fn probe_codex_models(cli_path: Option<&str>) -> Option<Vec<HeroiModel>> {
    let bin = resolve_codex(cli_path)?;
    let cwd = probe_cwd();
    let mut rpc = NdjsonRpc::spawn(&bin, &["app-server"], &cwd, CODEX_PROBE_TIMEOUT, RpcKind::Codex)
        .ok()?;
    rpc.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "strand",
                "title": "Strand",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": { "experimentalApi": true },
        }),
    )
    .ok()?;
    rpc.notify("initialized", None).ok()?;

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match cursor.as_deref() {
            Some(value) => json!({ "cursor": value }),
            None => json!({}),
        };
        let response = rpc.request("model/list", params).ok()?;
        models.extend(parse_codex_model_list(&response));
        cursor = response
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    if models.is_empty() {
        return None;
    }
    Some(apply_preferred_codex_default(models))
}

fn cursor_models() -> Vec<HeroiModel> {
    probe_cursor_models().unwrap_or_else(cursor_fallback)
}

fn probe_cursor_models() -> Option<Vec<HeroiModel>> {
    let bin = resolve_cursor()?;
    let cwd = probe_cwd();
    let mut rpc = NdjsonRpc::spawn(&bin, &["acp"], &cwd, CURSOR_PROBE_TIMEOUT, RpcKind::Acp).ok()?;
    rpc.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientInfo": {
                "name": "strand",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "clientCapabilities": {
                "_meta": { "parameterizedModelPicker": true },
            },
        }),
    )
    .ok()?;
    let _ = rpc.request("authenticate", json!({ "methodId": "cursor_login" }));
    let response = rpc
        .request("cursor/list_available_models", json!({}))
        .ok()?;
    let models = parse_cursor_models(&response);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn probe_cwd() -> PathBuf {
    std::env::temp_dir()
}

fn parse_codex_model_list(response: &Value) -> Vec<HeroiModel> {
    let Some(data) = response.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|entry| {
            if entry.get("hidden").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let slug = non_empty(entry.get("model"))?;
            let name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .map(codex_display_name)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| slug.clone());
            let default_effort = entry
                .get("defaultReasoningEffort")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let reasoning = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let id = option
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .or_else(|| option.as_str())?;
                    Some(HeroiReasoningOption {
                        label: reasoning_label(id),
                        is_default: id == default_effort,
                        id: id.to_string(),
                    })
                })
                .collect();
            Some(HeroiModel {
                is_default: entry.get("isDefault").and_then(Value::as_bool) == Some(true),
                slug,
                name,
                reasoning,
            })
        })
        .collect()
}

fn apply_preferred_codex_default(models: Vec<HeroiModel>) -> Vec<HeroiModel> {
    let preferred = PREFERRED_CODEX_DEFAULTS
        .iter()
        .copied()
        .find(|slug| models.iter().any(|model| model.slug == *slug));
    let Some(preferred) = preferred else {
        return models;
    };
    models
        .into_iter()
        .map(|mut model| {
            model.is_default = model.slug == preferred;
            model
        })
        .collect()
}

fn parse_cursor_models(response: &Value) -> Vec<HeroiModel> {
    let Some(models) = response.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    models
        .iter()
        .filter_map(|entry| {
            let slug = non_empty(entry.get("value"))?;
            if !seen.insert(slug.clone()) {
                return None;
            }
            let name = non_empty(entry.get("name")).unwrap_or_else(|| slug.clone());
            Some(HeroiModel {
                reasoning: cursor_reasoning(entry.get("configOptions")),
                slug,
                name,
                is_default: false,
            })
        })
        .collect()
}

fn cursor_reasoning(config_options: Option<&Value>) -> Vec<HeroiReasoningOption> {
    let Some(options) = config_options.and_then(Value::as_array) else {
        return Vec::new();
    };
    let selected = options.iter().filter(|option| {
        option.get("type").and_then(Value::as_str) == Some("select") && is_cursor_effort(option)
    });
    let effort = selected
        .clone()
        .find(|option| option_category(option) == "model_option")
        .or_else(|| {
            selected
                .clone()
                .find(|option| option_id(option) == "effort")
        })
        .or_else(|| {
            selected
                .clone()
                .find(|option| option_category(option) == "thought_level")
        })
        .or_else(|| selected.clone().next());
    let Some(effort) = effort else {
        return Vec::new();
    };
    let current = effort
        .get("currentValue")
        .and_then(Value::as_str)
        .and_then(normalize_cursor_reasoning);
    flatten_select_options(effort)
        .into_iter()
        .filter_map(|(id, label)| {
            let id = normalize_cursor_reasoning(&id)?;
            Some(HeroiReasoningOption {
                is_default: current.as_deref() == Some(id.as_str()),
                label,
                id,
            })
        })
        .collect()
}

fn is_cursor_effort(option: &Value) -> bool {
    let id = option_id(option);
    let name = option_name(option);
    id == "effort"
        || id == "reasoning"
        || name == "effort"
        || name == "reasoning"
        || name.contains("effort")
        || name.contains("reasoning")
}

fn option_id(option: &Value) -> String {
    option
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn option_name(option: &Value) -> String {
    option
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn option_category(option: &Value) -> String {
    option
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn flatten_select_options(option: &Value) -> Vec<(String, String)> {
    let Some(options) = option.get("options").and_then(Value::as_array) else {
        return Vec::new();
    };
    options
        .iter()
        .flat_map(|entry| {
            if let Some(value) = non_empty(entry.get("value")) {
                let name = non_empty(entry.get("name")).unwrap_or_else(|| value.clone());
                return vec![(value, name)];
            }
            entry
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|nested| {
                    let value = non_empty(nested.get("value"))?;
                    let name = non_empty(nested.get("name")).unwrap_or_else(|| value.clone());
                    Some((value, name))
                })
                .collect()
        })
        .collect()
}

fn normalize_cursor_reasoning(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" | "max" => Some(value.trim().to_ascii_lowercase()),
        "xhigh" | "extra-high" | "extra high" => Some("xhigh".into()),
        _ => None,
    }
}

fn codex_fallback() -> Vec<HeroiModel> {
    let reasoning = effort(&[
        ("low", "Low", false),
        ("medium", "Medium", true),
        ("high", "High", false),
        ("xhigh", "Extra High", false),
    ]);
    vec![
        model("gpt-5.6-sol", "GPT-5.6-Sol", true, reasoning.clone()),
        model("gpt-5.6-terra", "GPT-5.6-Terra", false, reasoning.clone()),
        model("gpt-5.4", "GPT-5.4", false, reasoning),
    ]
}

fn cursor_fallback() -> Vec<HeroiModel> {
    vec![model("auto", "Auto", true, Vec::new())]
}

fn model(
    slug: &str,
    name: &str,
    is_default: bool,
    reasoning: Vec<HeroiReasoningOption>,
) -> HeroiModel {
    HeroiModel {
        slug: slug.into(),
        name: name.into(),
        is_default,
        reasoning,
    }
}

fn effort(options: &[(&str, &str, bool)]) -> Vec<HeroiReasoningOption> {
    options
        .iter()
        .map(|(id, label, is_default)| HeroiReasoningOption {
            id: (*id).into(),
            label: (*label).into(),
            is_default: *is_default,
        })
        .collect()
}

fn reasoning_label(id: &str) -> String {
    match id {
        "none" => "None".into(),
        "minimal" => "Minimal".into(),
        "low" => "Low".into(),
        "medium" => "Medium".into(),
        "high" => "High".into(),
        "xhigh" => "Extra High".into(),
        "max" => "Max".into(),
        "ultra" => "Ultra".into(),
        "ultrathink" => "Ultrathink".into(),
        "ultracode" => "Ultracode".into(),
        other => other.to_string(),
    }
}

fn codex_display_name(name: &str) -> String {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut out = String::new();
    if name.len() >= 3 && name[..3].eq_ignore_ascii_case("gpt") {
        out.push_str("GPT");
        out.extend(name.chars().skip(3));
    } else {
        out.push(first);
        out.extend(chars);
    }
    let mut result = String::new();
    let mut capitalize_next = false;
    for ch in out.chars() {
        if ch == '-' {
            capitalize_next = true;
            result.push(ch);
        } else if capitalize_next {
            result.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
        }
    }
    result
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_semver(output: &str) -> Option<(u32, u32, u32)> {
    let mut parts = output
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .find(|token| token.split('.').count() >= 3)?
        .split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn version_at_least(version: Option<(u32, u32, u32)>, minimum: (u32, u32, u32)) -> bool {
    version.is_some_and(|current| current >= minimum)
}

const CLAUDE_ALIASES: &[(&str, &str)] = &[
    ("opus", "claude-opus-5"),
    ("opus-5", "claude-opus-5"),
    ("sonnet", "claude-sonnet-5"),
    ("sonnet-5", "claude-sonnet-5"),
    ("haiku", "claude-haiku-4-5"),
];

const CODEX_ALIASES: &[(&str, &str)] = &[
    ("gpt-5-codex", "gpt-5.4"),
    ("5.4", "gpt-5.4"),
    ("gpt-5.6-codex", "gpt-5.6-sol"),
];

const CURSOR_ALIASES: &[(&str, &str)] = &[
    ("composer", "composer-2"),
    ("default", "auto"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_catalog_gates_opus_5_on_cli_version() {
        let unknown = claude_catalog(None);
        assert!(!unknown.iter().any(|model| model.slug == "claude-opus-5"));
        assert!(unknown.iter().any(|model| model.slug == "claude-sonnet-5"));

        let current = claude_catalog(Some((2, 1, 219)));
        assert!(current.iter().any(|model| model.slug == "claude-opus-5"));
        assert!(current.iter().any(|model| model.slug == "claude-fable-5"));
        let sonnet = current
            .iter()
            .find(|model| model.slug == "claude-sonnet-5")
            .unwrap();
        assert!(sonnet.is_default);
        assert!(sonnet
            .reasoning
            .iter()
            .any(|option| option.id == "xhigh" && option.label == "Extra High"));
        assert!(sonnet
            .reasoning
            .iter()
            .any(|option| option.id == "ultrathink"));
    }

    #[test]
    fn parses_codex_model_list_and_prefers_sol() {
        let response = json!({
            "data": [
                {
                    "model": "gpt-5.4",
                    "displayName": "gpt-5.4",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low" },
                        { "reasoningEffort": "medium" },
                        { "reasoningEffort": "high" },
                        { "reasoningEffort": "xhigh" }
                    ]
                },
                {
                    "model": "gpt-5.6-sol",
                    "displayName": "gpt-5.6-sol",
                    "hidden": false,
                    "isDefault": false,
                    "defaultReasoningEffort": "high",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low" },
                        { "reasoningEffort": "high" }
                    ]
                }
            ]
        });
        let models = apply_preferred_codex_default(parse_codex_model_list(&response));
        assert_eq!(models[0].name, "GPT-5.4");
        assert!(!models[0].is_default);
        assert_eq!(models[1].slug, "gpt-5.6-sol");
        assert!(models[1].is_default);
        assert_eq!(
            models[1]
                .reasoning
                .iter()
                .find(|option| option.is_default)
                .map(|option| option.id.as_str()),
            Some("high")
        );
        assert_eq!(
            models[0]
                .reasoning
                .iter()
                .find(|option| option.id == "xhigh")
                .map(|option| option.label.as_str()),
            Some("Extra High")
        );
    }

    #[test]
    fn parses_cursor_models_and_reasoning() {
        let response = json!({
            "models": [
                {
                    "value": "auto",
                    "name": "Auto",
                    "configOptions": []
                },
                {
                    "value": "composer-2",
                    "name": "Composer 2",
                    "configOptions": [
                        {
                            "type": "select",
                            "id": "effort",
                            "name": "Reasoning",
                            "category": "thought_level",
                            "currentValue": "high",
                            "options": [
                                { "name": "Low", "value": "low" },
                                { "name": "High", "value": "high" },
                                { "name": "Extra High", "value": "xhigh" }
                            ]
                        }
                    ]
                }
            ]
        });
        let models = parse_cursor_models(&response);
        assert_eq!(models[0].slug, "auto");
        assert!(models[0].reasoning.is_empty());
        assert_eq!(models[1].slug, "composer-2");
        assert_eq!(
            models[1]
                .reasoning
                .iter()
                .find(|option| option.is_default)
                .map(|option| option.id.as_str()),
            Some("high")
        );
        assert!(models[1]
            .reasoning
            .iter()
            .any(|option| option.id == "xhigh"));
    }

    #[test]
    fn claude_effort_maps_like_t3code() {
        assert_eq!(normalize_claude_cli_effort("ultrathink", Some("claude-opus-5")), None);
        assert_eq!(
            normalize_claude_cli_effort("ultracode", Some("claude-opus-5")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            normalize_claude_cli_effort("xhigh", Some("claude-opus-4-6")).as_deref(),
            Some("max")
        );
        assert_eq!(
            normalize_claude_cli_effort("xhigh", Some("claude-opus-5")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            apply_claude_prompt_effort("fix the tests", Some("ultrathink")),
            "Ultrathink:\nfix the tests"
        );
        assert_eq!(
            apply_claude_prompt_effort("/compact", Some("ultrathink")),
            "/compact"
        );
    }

    #[test]
    fn aliases_expand_legacy_picker_values() {
        assert_eq!(canonicalize_model(HeroiProvider::Claude, "opus"), "claude-opus-5");
        assert_eq!(canonicalize_model(HeroiProvider::Claude, "sonnet"), "claude-sonnet-5");
        assert_eq!(canonicalize_model(HeroiProvider::Codex, "gpt-5.6-codex"), "gpt-5.6-sol");
        assert_eq!(canonicalize_model(HeroiProvider::Cursor, "composer"), "composer-2");
    }
}
