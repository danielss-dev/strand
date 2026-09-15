use std::collections::HashMap;
use std::path::Path;
use std::{collections::BTreeMap, fs, path::PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::ai::bin::{
    resolve_claude, resolve_codex, resolve_cursor, run_streaming_lines, AiCancelHandle,
};

mod models;
mod rpc;

pub use models::{list_models, HeroiModelCatalog};

#[derive(Debug, Clone, Serialize)]
pub struct HeroiSkill {
    name: String,
    description: Option<String>,
    scope: &'static str,
}

pub fn list_skills(path: &Path, provider: HeroiProvider) -> Vec<HeroiSkill> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        roots.push((home.join(match provider {
            HeroiProvider::Claude => ".claude/skills",
            HeroiProvider::Codex => ".codex/skills",
            HeroiProvider::Cursor => ".cursor/skills",
        }), "user"));
    }
    roots.push((path.join(".agents/skills"), "project"));
    roots.push((path.join(match provider {
        HeroiProvider::Claude => ".claude/skills",
        HeroiProvider::Codex => ".codex/skills",
        HeroiProvider::Cursor => ".cursor/skills",
    }), "project"));

    let mut skills = BTreeMap::new();
    for (root, scope) in roots {
        let Ok(entries) = fs::read_dir(root) else { continue };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let skill_path = entry.path().join("SKILL.md");
            let Ok(contents) = fs::read_to_string(skill_path) else { continue };
            let fallback = entry.file_name().to_string_lossy().trim().to_owned();
            let (name, description) = skill_frontmatter(&contents);
            let name = name.unwrap_or(fallback);
            if name.is_empty() { continue }
            skills.insert(name.clone(), HeroiSkill { name, description, scope });
        }
    }
    skills.into_values().collect()
}

fn skill_frontmatter(contents: &str) -> (Option<String>, Option<String>) {
    let normalized = contents.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else { return (None, None) };
    let Some((frontmatter, _)) = rest.split_once("\n---") else { return (None, None) };
    let field = |key: &str| frontmatter.lines().find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_owned())
    }).filter(|value| !value.is_empty());
    (field("name"), field("description"))
}

#[cfg(test)]
mod skill_tests {
    use super::skill_frontmatter;

    #[test]
    fn reads_skill_name_and_description() {
        assert_eq!(
            skill_frontmatter("---\r\nname: verify\r\ndescription: Drive the app\r\n---\r\n# Verify"),
            (Some("verify".into()), Some("Drive the app".into()))
        );
    }

    #[test]
    fn ignores_documents_without_frontmatter() {
        assert_eq!(skill_frontmatter("# Verify"), (None, None));
    }
}

const AGENT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_HEROI_IMAGES: usize = 4;
const MAX_HEROI_IMAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HeroiProvider {
    Claude,
    Codex,
    Cursor,
}

impl HeroiProvider {
    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor Agent",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroiAgentRequest {
    pub path: String,
    pub provider: HeroiProvider,
    pub prompt: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub agent_mode: String,
    pub permission_mode: String,
    pub cli_path: Option<String>,
    #[serde(default)]
    pub images: Vec<HeroiImageAttachment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroiImageAttachment {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroiAgentOutcome {
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HeroiAgentEvent {
    Status {
        message: String,
    },
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Text {
        text: String,
    },
    Activity {
        id: String,
        label: String,
        detail: Option<String>,
        done: bool,
    },
}

#[derive(Default)]
struct ParseState {
    session_id: Option<String>,
    emitted_text: bool,
    pending_tools: HashMap<String, PendingTool>,
}

struct PendingTool {
    label: String,
    detail: Option<String>,
}

struct MaterializedImages {
    dir: Option<PathBuf>,
    paths: Vec<PathBuf>,
}

impl Drop for MaterializedImages {
    fn drop(&mut self) {
        if let Some(dir) = &self.dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

pub fn run_agent(
    mut request: HeroiAgentRequest,
    cancel: &AiCancelHandle,
    on_event: Channel<HeroiAgentEvent>,
) -> Result<HeroiAgentOutcome, String> {
    validate_request(&request)?;
    if request.provider == HeroiProvider::Claude {
        request.prompt = models::apply_claude_prompt_effort(
            &request.prompt,
            selected(request.thinking.as_deref()),
        );
    }
    let program = match request.provider {
        HeroiProvider::Claude => resolve_claude(request.cli_path.as_deref()),
        HeroiProvider::Codex => resolve_codex(request.cli_path.as_deref()),
        HeroiProvider::Cursor => resolve_cursor(),
    }
    .ok_or_else(|| {
        format!(
            "{} CLI was not found. Install it and make sure it is available on PATH.",
            request.provider.label()
        )
    })?;
    let images = materialize_images(&request)?;
    let stdin = stdin_payload(&request, &images.paths);
    let args = build_args(&request, &images.paths);
    let mut parsed = ParseState::default();
    let _ = on_event.send(HeroiAgentEvent::Status {
        message: format!("Starting {}", request.provider.label()),
    });

    let result = run_streaming_lines(
        &program,
        &args,
        Path::new(&request.path),
        &stdin,
        AGENT_TIMEOUT,
        cancel,
        |line| parse_line(request.provider, line, &mut parsed, &on_event),
    );
    result.map_err(|error| {
        friendly_error(request.provider, &error, !request.images.is_empty())
    })?;
    let _ = on_event.send(HeroiAgentEvent::Status {
        message: "Ready".into(),
    });
    Ok(HeroiAgentOutcome {
        session_id: parsed.session_id,
    })
}

fn validate_request(request: &HeroiAgentRequest) -> Result<(), String> {
    if request.prompt.trim().is_empty() && request.images.is_empty() {
        return Err("Write a message before sending.".into());
    }
    if request.prompt.len() > MAX_PROMPT_BYTES {
        return Err("The message is larger than Heroi's 128 KiB limit.".into());
    }
    if !Path::new(&request.path).is_dir() {
        return Err("The active repository directory is unavailable.".into());
    }
    if request.path.contains('\0') || request.session_id.as_deref().is_some_and(invalid_id) {
        return Err("The agent session request is invalid.".into());
    }
    if !matches!(request.agent_mode.as_str(), "plan" | "build")
        || !matches!(request.permission_mode.as_str(), "read" | "build" | "full")
        || !valid_setting(request.model.as_deref(), 128)
        || !valid_setting(request.thinking.as_deref(), 32)
    {
        return Err("The selected agent settings are invalid.".into());
    }
    validate_images(&request.images)?;
    Ok(())
}

fn validate_images(images: &[HeroiImageAttachment]) -> Result<(), String> {
    if images.len() > MAX_HEROI_IMAGES {
        return Err("Heroi accepts up to 4 images per message.".into());
    }
    for image in images {
        if invalid_image_name(&image.name) {
            return Err("An attached image has an invalid file name.".into());
        }
        if normalize_image_mime(&image.mime_type).is_none() {
            return Err("Heroi can only attach PNG, JPEG, GIF, or WebP images.".into());
        }
        let bytes = BASE64
            .decode(image.data_base64.trim().as_bytes())
            .map_err(|_| "Heroi could not read an attached image.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_HEROI_IMAGE_BYTES {
            return Err("Each attached image must be 4 MiB or smaller.".into());
        }
    }
    Ok(())
}

fn invalid_image_name(name: &str) -> bool {
    let trimmed = name.trim();
    trimmed.is_empty()
        || trimmed.len() > 128
        || trimmed.contains(['/', '\\', '\0', '\n', '\r'])
        || trimmed.contains("..")
}

fn normalize_image_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn valid_setting(value: Option<&str>, max_len: usize) -> bool {
    match value {
        None => true,
        Some(value) if value.trim().is_empty() || value.eq_ignore_ascii_case("default") => true,
        Some(value) => {
            let trimmed = value.trim();
            trimmed.len() <= max_len
                && trimmed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        }
    }
}

fn invalid_id(value: &str) -> bool {
    value.is_empty() || value.len() > 256 || value.contains(['\r', '\n', '\0'])
}

fn selected(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty() && !value.eq_ignore_ascii_case("default"))
}

fn build_args(request: &HeroiAgentRequest, image_paths: &[PathBuf]) -> Vec<String> {
    match request.provider {
        HeroiProvider::Claude => claude_args(request),
        HeroiProvider::Codex => codex_args(request, image_paths),
        HeroiProvider::Cursor => cursor_args(request, image_paths),
    }
}

fn claude_args(request: &HeroiAgentRequest) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    if !request.images.is_empty() {
        args.extend(["--input-format".into(), "stream-json".into()]);
    }
    if let Some(session_id) = request.session_id.as_deref() {
        args.extend(["--resume".into(), session_id.into()]);
    }
    if let Some(model) = resolved_model(request) {
        args.extend(["--model".into(), model]);
    }
    if let Some(effort) = selected(request.thinking.as_deref()).and_then(|effort| {
        models::normalize_claude_cli_effort(effort, resolved_model(request).as_deref())
    }) {
        args.extend(["--effort".into(), effort]);
    }
    if request.permission_mode == "full" {
        args.push("--dangerously-skip-permissions".into());
    } else {
        let mode = if request.agent_mode == "plan" || request.permission_mode == "read" {
            "plan"
        } else {
            "acceptEdits"
        };
        args.extend(["--permission-mode".into(), mode.into()]);
    }
    args
}

fn codex_args(request: &HeroiAgentRequest, image_paths: &[PathBuf]) -> Vec<String> {
    let mut args = vec!["exec".into(), "--cd".into(), request.path.clone()];
    if let Some(session_id) = request.session_id.as_deref() {
        add_codex_access(&mut args, request);
        args.extend([
            "resume".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
        ]);
        add_codex_options(&mut args, request);
        add_image_flags(&mut args, image_paths);
        args.extend([session_id.into(), "-".into()]);
        return args;
    }
    args.extend([
        "--json".into(),
        "--color".into(),
        "never".into(),
        "--skip-git-repo-check".into(),
    ]);
    add_codex_options(&mut args, request);
    add_codex_access(&mut args, request);
    add_image_flags(&mut args, image_paths);
    args.push("-".into());
    args
}

fn add_codex_access(args: &mut Vec<String>, request: &HeroiAgentRequest) {
    if request.permission_mode == "full" {
        args.push("--dangerously-bypass-approvals-and-sandbox".into());
    } else {
        args.extend([
            "--sandbox".into(),
            if request.agent_mode == "plan" || request.permission_mode == "read" {
                "read-only"
            } else {
                "workspace-write"
            }
            .into(),
        ]);
    }
}

fn resolved_model(request: &HeroiAgentRequest) -> Option<String> {
    selected(request.model.as_deref())
        .map(|model| models::canonicalize_model(request.provider, model))
}

fn add_codex_options(args: &mut Vec<String>, request: &HeroiAgentRequest) {
    if let Some(model) = resolved_model(request) {
        args.extend(["--model".into(), model]);
    }
    if let Some(effort) = selected(request.thinking.as_deref()) {
        args.extend([
            "--config".into(),
            format!("model_reasoning_effort=\"{effort}\""),
        ]);
    }
}

fn cursor_args(request: &HeroiAgentRequest, _image_paths: &[PathBuf]) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--trust".into(),
        "--workspace".into(),
        request.path.clone(),
    ];
    if let Some(session_id) = request.session_id.as_deref() {
        args.extend(["--resume".into(), session_id.into()]);
    }
    if let Some(model) = resolved_model(request) {
        args.extend(["--model".into(), model]);
    }
    if request.agent_mode == "plan" || request.permission_mode == "read" {
        args.extend(["--mode".into(), "plan".into()]);
    } else {
        // Headless `--print` only proposes edits and commands unless `--force`.
        // Build keeps the CLI sandbox; Full disables it.
        args.push("--force".into());
        if request.permission_mode == "full" {
            args.extend(["--sandbox".into(), "disabled".into()]);
        }
    }
    args
}

fn add_image_flags(args: &mut Vec<String>, image_paths: &[PathBuf]) {
    for path in image_paths {
        args.extend(["--image".into(), path.to_string_lossy().into_owned()]);
    }
}

fn materialize_images(request: &HeroiAgentRequest) -> Result<MaterializedImages, String> {
    if request.images.is_empty() || request.provider == HeroiProvider::Claude {
        return Ok(MaterializedImages {
            dir: None,
            paths: Vec::new(),
        });
    }
    let dir = image_staging_dir(request);
    fs::create_dir_all(&dir).map_err(|_| "Heroi could not store attached images.".to_string())?;
    let mut paths = Vec::with_capacity(request.images.len());
    for (index, image) in request.images.iter().enumerate() {
        let mime = normalize_image_mime(&image.mime_type).unwrap_or("image/png");
        let bytes = BASE64
            .decode(image.data_base64.trim().as_bytes())
            .map_err(|_| "Heroi could not read an attached image.".to_string())?;
        let path = dir.join(format!("image-{index}.{}", image_extension(mime)));
        fs::write(&path, bytes).map_err(|_| "Heroi could not store attached images.".to_string())?;
        paths.push(path);
    }
    Ok(MaterializedImages {
        dir: Some(dir),
        paths,
    })
}

fn image_staging_dir(request: &HeroiAgentRequest) -> PathBuf {
    let name = format!("strand-heroi-{}", uuid::Uuid::new_v4());
    if request.provider == HeroiProvider::Cursor {
        let git_dir = Path::new(&request.path).join(".git");
        let root = if git_dir.is_dir() {
            git_dir
        } else {
            PathBuf::from(&request.path)
        };
        return root.join(name);
    }
    std::env::temp_dir().join(name)
}

fn stdin_payload(request: &HeroiAgentRequest, image_paths: &[PathBuf]) -> String {
    match request.provider {
        HeroiProvider::Claude if !request.images.is_empty() => claude_image_stdin(request),
        _ => {
            let mut text = request.prompt.clone();
            if request.provider != HeroiProvider::Claude && !image_paths.is_empty() {
                let list = image_paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str("Attached images:\n");
                text.push_str(&list);
            }
            text
        }
    }
}

fn claude_image_stdin(request: &HeroiAgentRequest) -> String {
    let mut content = Vec::new();
    let text = request.prompt.trim();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for image in &request.images {
        let mime = normalize_image_mime(&image.mime_type).unwrap_or("image/png");
        content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": image.data_base64.trim(),
            }
        }));
    }
    format!(
        "{}\n",
        json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": Value::Null,
        })
    )
}

fn parse_line(
    provider: HeroiProvider,
    line: &str,
    state: &mut ParseState,
    on_event: &Channel<HeroiAgentEvent>,
) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if state.session_id.is_none() {
        if let Some(session_id) = session_id(provider, &value) {
            state.session_id = Some(session_id.to_string());
            let _ = on_event.send(HeroiAgentEvent::Session {
                session_id: session_id.to_string(),
            });
        }
    }
    if let Some(activity) = activity_data(provider, &value, state) {
        let _ = on_event.send(HeroiAgentEvent::Activity {
            id: activity.id,
            label: activity.label,
            detail: activity.detail,
            done: activity.done,
        });
    }
    if let Some(text) = assistant_text(provider, &value, state.emitted_text) {
        if !text.trim().is_empty() {
            state.emitted_text = true;
            let _ = on_event.send(HeroiAgentEvent::Text { text });
        }
    }
}

fn session_id(provider: HeroiProvider, value: &Value) -> Option<&str> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match provider {
        HeroiProvider::Codex if event_type == "thread.started" => {
            value.get("thread_id").and_then(Value::as_str)
        }
        HeroiProvider::Codex => None,
        HeroiProvider::Claude | HeroiProvider::Cursor => value
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .or_else(|| value.get("chat_id"))
            .or_else(|| value.get("chatId"))
            .and_then(Value::as_str),
    }
}

fn assistant_text(provider: HeroiProvider, value: &Value, emitted: bool) -> Option<String> {
    let event_type = value.get("type").and_then(Value::as_str)?;
    if provider == HeroiProvider::Codex {
        let item = value.get("item")?;
        return (event_type == "item.completed"
            && item.get("type").and_then(Value::as_str) == Some("agent_message"))
        .then(|| item.get("text").and_then(Value::as_str).map(str::to_string))
        .flatten();
    }
    if event_type == "assistant" {
        let blocks = value.get("message")?.get("content")?.as_array()?;
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.is_empty()).then_some(text);
    }
    if event_type == "result" && !emitted {
        return value
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    None
}

struct ActivityData {
    id: String,
    label: String,
    detail: Option<String>,
    done: bool,
}

fn activity_data(provider: HeroiProvider, value: &Value, state: &mut ParseState) -> Option<ActivityData> {
    let event_type = value.get("type").and_then(Value::as_str)?;
    if provider == HeroiProvider::Codex
        && matches!(event_type, "item.started" | "item.completed")
    {
        let item = value.get("item")?;
        let item_type = item.get("type")?.as_str()?;
        let label = match item_type {
            "command_execution" => "Running a command",
            "mcp_tool_call" => "Using a tool",
            "file_change" => "Editing files",
            _ => return None,
        };
        let mut detail = item
            .get("command")
            .or_else(|| item.get("arguments"))
            .or_else(|| item.get("changes"))
            .map(format_activity_value);
        if let Some(output) = item
            .get("aggregated_output")
            .or_else(|| item.get("output"))
            .map(format_activity_value)
            .filter(|output| !output.is_empty())
        {
            detail = Some(match detail {
                Some(command) if !command.is_empty() => format!("{command}\n\n{output}"),
                _ => output,
            });
        }
        return Some(ActivityData {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(label)
                .to_owned(),
            label: label.into(),
            detail,
            done: event_type == "item.completed",
        });
    }
    if provider == HeroiProvider::Cursor && event_type == "tool_call" {
        let call_value = value.get("tool_call")?;
        let call = call_value.as_object()?;
        let kind = call.keys().next()?.as_str();
        let label = if kind.to_ascii_lowercase().contains("write") {
            "Editing files"
        } else if is_command_tool(kind) {
            "Running a command"
        } else {
            "Using a tool"
        };
        return Some(ActivityData {
            id: value
                .get("id")
                .or_else(|| call_value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or(kind)
                .to_owned(),
            label: label.into(),
            detail: Some(cursor_activity_detail(call_value)),
            done: value
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| matches!(status, "completed" | "done")),
        });
    }
    if event_type == "assistant" {
        let block = value
            .get("message")?
            .get("content")?
            .as_array()?
            .iter()
            .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))?;
        let name = block.get("name")?.as_str()?;
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(name)
            .to_owned();
        let label = if is_command_tool(name) {
            "Running a command".into()
        } else {
            format!("Using {name}")
        };
        let detail = command_from_value(block.get("input"))
            .or_else(|| block.get("input").map(format_activity_value));
        state.pending_tools.insert(
            id.clone(),
            PendingTool {
                label: label.clone(),
                detail: detail.clone(),
            },
        );
        return Some(ActivityData {
            id,
            label,
            detail,
            done: false,
        });
    }
    if event_type == "user" {
        let block = value
            .get("message")?
            .get("content")?
            .as_array()?
            .iter()
            .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))?;
        let id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_owned();
        let output = tool_result_text(block).filter(|text| !text.is_empty());
        let pending = state.pending_tools.remove(&id);
        let label = pending
            .as_ref()
            .map(|tool| tool.label.clone())
            .unwrap_or_else(|| "Using a tool".into());
        let detail = match (pending.and_then(|tool| tool.detail), output) {
            (Some(command), Some(output)) if !command.is_empty() && !output.is_empty() => {
                Some(format!("{command}\n\n{output}"))
            }
            (Some(command), Some(output)) if command.is_empty() => Some(output),
            (Some(command), Some(_)) => Some(command),
            (Some(command), None) => Some(command),
            (None, Some(output)) => Some(output),
            (None, None) => None,
        };
        return Some(ActivityData {
            id,
            label,
            detail,
            done: true,
        });
    }
    None
}

fn is_command_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("bash")
        || lower.contains("shell")
        || lower.contains("terminal")
        || lower.contains("powershell")
        || lower == "command"
        || lower.contains("command_execution")
}

fn command_from_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(command) = value.get("command").and_then(Value::as_str) {
        return Some(command.to_string());
    }
    if let Some(command) = value.get("cmd").and_then(Value::as_str) {
        return Some(command.to_string());
    }
    find_string_field(value, &["command", "cmd", "shellCommand"])
}

fn cursor_activity_detail(value: &Value) -> String {
    let command = command_from_value(Some(value));
    let output = find_string_field(value, &["aggregated_output", "output", "stdout", "result"])
        .filter(|text| !text.is_empty());
    match (command, output) {
        (Some(command), Some(output)) => format!("{command}\n\n{output}"),
        (Some(command), None) => command,
        (None, Some(output)) => output,
        (None, None) => format_activity_value(value),
    }
}

fn find_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    fn walk(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for key in keys {
                    if let Some(Value::String(text)) = map.get(*key) {
                        if !text.is_empty() {
                            return Some(text.clone());
                        }
                    }
                }
                for nested in map.values() {
                    if let Some(found) = walk(nested, keys, depth + 1) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(|item| walk(item, keys, depth + 1)),
            _ => None,
        }
    }
    walk(value, keys, 0)
}

fn tool_result_text(block: &Value) -> Option<String> {
    let content = block.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.as_str().map(str::to_string).or_else(|| {
                (part.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| part.get("text").and_then(Value::as_str).map(str::to_string))
                    .flatten()
            })
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn format_activity_value(value: &Value) -> String {
    const MAX_DETAIL_BYTES: usize = 16 * 1024;
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap_or_default());
    if text.len() <= MAX_DETAIL_BYTES {
        return text;
    }
    let mut end = MAX_DETAIL_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… output truncated by Heroi", &text[..end])
}

fn friendly_error(provider: HeroiProvider, raw: &str, has_images: bool) -> String {
    if raw == "cancelled" {
        return raw.into();
    }
    let prefix = raw.lines().next().unwrap_or_default();
    let normalized = prefix.to_ascii_lowercase();
    if has_images && image_unsupported(&normalized) {
        return format!(
            "{} does not accept images with the selected model or CLI. Remove the attachments or pick a vision-capable model.",
            provider.label()
        );
    }
    if normalized.contains("not logged in")
        || normalized.contains("not authenticated")
        || normalized.contains("authentication")
        || normalized.contains("unauthorized")
    {
        return format!(
            "{} is not signed in. Sign in with its CLI, then try again.",
            provider.label()
        );
    }
    if normalized.contains("rate limit") || normalized.contains("429") {
        return format!(
            "{} is rate-limited right now. Wait a moment, then try again.",
            provider.label()
        );
    }
    format!(
        "{} stopped before completing the reply. Check its CLI login and selected model, then try again.",
        provider.label()
    )
}

fn image_unsupported(normalized: &str) -> bool {
    normalized.contains("--image")
        || normalized.contains("does not support image")
        || normalized.contains("images are not supported")
        || normalized.contains("vision is not")
        || normalized.contains("no vision")
        || ((normalized.contains("unknown option")
            || normalized.contains("unrecognized option")
            || normalized.contains("unexpected argument"))
            && normalized.contains("image"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: HeroiProvider) -> HeroiAgentRequest {
        HeroiAgentRequest {
            path: ".".into(),
            provider,
            prompt: "hello".into(),
            session_id: None,
            model: Some("default".into()),
            thinking: Some("high".into()),
            agent_mode: "build".into(),
            permission_mode: "build".into(),
            cli_path: None,
            images: Vec::new(),
        }
    }

    fn png_attachment() -> HeroiImageAttachment {
        HeroiImageAttachment {
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            data_base64: BASE64.encode([0x89, b'P', b'N', b'G', 0x0D, 0x0A]),
        }
    }

    #[test]
    fn codex_resume_uses_the_recorded_thread() {
        let mut input = request(HeroiProvider::Codex);
        input.session_id = Some("thread-1".into());
        input.permission_mode = "read".into();
        let args = build_args(&input, &[]);
        assert_eq!(&args[..5], ["exec", "--cd", ".", "--sandbox", "read-only"]);
        assert!(args.windows(2).any(|pair| pair == ["resume", "--json"]));
        assert!(args.ends_with(&["thread-1".into(), "-".into()]));
    }

    #[test]
    fn claude_build_mode_accepts_edits_without_full_bypass() {
        let args = build_args(&request(HeroiProvider::Claude), &[]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "acceptEdits"]));
        assert!(!args.contains(&"--dangerously-skip-permissions".into()));
        assert!(!args.contains(&"--input-format".into()));
    }

    #[test]
    fn claude_expands_legacy_model_aliases_and_maps_effort() {
        let mut input = request(HeroiProvider::Claude);
        input.model = Some("opus".into());
        input.thinking = Some("ultrathink".into());
        let args = build_args(&input, &[]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model", "claude-opus-5"]));
        assert!(!args.windows(2).any(|pair| pair == ["--effort", "ultrathink"]));

        input.thinking = Some("xhigh".into());
        let args = build_args(&input, &[]);
        assert!(args.windows(2).any(|pair| pair == ["--effort", "xhigh"]));
    }

    #[test]
    fn accepts_provider_advertised_reasoning_tokens() {
        let mut input = request(HeroiProvider::Codex);
        input.thinking = Some("xhigh".into());
        input.model = Some("gpt-5.6-sol".into());
        assert!(validate_request(&input).is_ok());
    }

    #[test]
    fn cursor_plan_mode_is_explicitly_read_only() {
        let mut input = request(HeroiProvider::Cursor);
        input.agent_mode = "plan".into();
        let args = build_args(&input, &[]);
        assert!(args.windows(2).any(|pair| pair == ["--mode", "plan"]));
        assert!(args.windows(2).any(|pair| pair == ["--workspace", "."]));
        assert!(!args.contains(&"--force".into()));
    }

    #[test]
    fn cursor_build_forces_headless_commands_without_skipping_sandbox() {
        let args = build_args(&request(HeroiProvider::Cursor), &[]);
        assert!(args.contains(&"--force".into()));
        assert!(args.windows(2).any(|pair| pair == ["--workspace", "."]));
        assert!(!args.windows(2).any(|pair| pair == ["--mode", "plan"]));
        assert!(!args.windows(2).any(|pair| pair == ["--sandbox", "disabled"]));
    }

    #[test]
    fn cursor_full_access_disables_sandbox() {
        let mut input = request(HeroiProvider::Cursor);
        input.permission_mode = "full".into();
        let args = build_args(&input, &[]);
        assert!(args.contains(&"--force".into()));
        assert!(args.windows(2).any(|pair| pair == ["--sandbox", "disabled"]));
        assert!(!args.windows(2).any(|pair| pair == ["--mode", "plan"]));
    }

    #[test]
    fn extracts_provider_session_and_assistant_text() {
        let codex: Value =
            serde_json::from_str(r#"{"type":"thread.started","thread_id":"abc"}"#).unwrap();
        assert_eq!(session_id(HeroiProvider::Codex, &codex), Some("abc"));

        let claude: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            assistant_text(HeroiProvider::Claude, &claude, false).as_deref(),
            Some("Done")
        );
    }

    #[test]
    fn captures_expandable_codex_command_and_output() {
        let mut state = ParseState::default();
        let started = serde_json::json!({
            "type": "item.started",
            "item": { "id": "cmd-1", "type": "command_execution", "command": "cargo check" }
        });
        let activity = activity_data(HeroiProvider::Codex, &started, &mut state).unwrap();
        assert_eq!(activity.id, "cmd-1");
        assert_eq!(activity.label, "Running a command");
        assert_eq!(activity.detail.as_deref(), Some("cargo check"));
        assert!(!activity.done);

        let completed = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "cmd-1",
                "type": "command_execution",
                "command": "cargo check",
                "aggregated_output": "Finished successfully"
            }
        });
        let activity = activity_data(HeroiProvider::Codex, &completed, &mut state).unwrap();
        assert_eq!(activity.detail.as_deref(), Some("cargo check\n\nFinished successfully"));
        assert!(activity.done);
    }

    #[test]
    fn captures_claude_bash_command_and_tool_result() {
        let mut state = ParseState::default();
        let started = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu-1",
                    "name": "Bash",
                    "input": { "command": "pnpm test" }
                }]
            }
        });
        let activity = activity_data(HeroiProvider::Claude, &started, &mut state).unwrap();
        assert_eq!(activity.id, "toolu-1");
        assert_eq!(activity.label, "Running a command");
        assert_eq!(activity.detail.as_deref(), Some("pnpm test"));
        assert!(!activity.done);

        let completed = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu-1",
                    "content": "Tests passed"
                }]
            }
        });
        let activity = activity_data(HeroiProvider::Claude, &completed, &mut state).unwrap();
        assert_eq!(activity.detail.as_deref(), Some("pnpm test\n\nTests passed"));
        assert!(activity.done);
    }

    #[test]
    fn captures_cursor_terminal_command_and_output() {
        let mut state = ParseState::default();
        let event = serde_json::json!({
            "type": "tool_call",
            "id": "term-1",
            "status": "completed",
            "tool_call": {
                "shellToolCall": {
                    "args": { "command": "cargo check" },
                    "result": { "output": "Finished `dev` profile" }
                }
            }
        });
        let activity = activity_data(HeroiProvider::Cursor, &event, &mut state).unwrap();
        assert_eq!(activity.label, "Running a command");
        assert_eq!(
            activity.detail.as_deref(),
            Some("cargo check\n\nFinished `dev` profile")
        );
        assert!(activity.done);
    }

    #[test]
    fn image_only_messages_are_valid_and_reach_providers() {
        let mut input = request(HeroiProvider::Claude);
        input.prompt = String::new();
        input.images = vec![png_attachment()];
        assert!(validate_request(&input).is_ok());

        let args = build_args(&input, &[]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--input-format", "stream-json"]));
        let stdin = stdin_payload(&input, &[]);
        assert!(stdin.contains("\"type\":\"image\""));
        assert!(stdin.contains("image/png"));

        let image_path = PathBuf::from("/tmp/shot.png");
        let mut codex = request(HeroiProvider::Codex);
        codex.images = vec![png_attachment()];
        let args = build_args(&codex, std::slice::from_ref(&image_path));
        assert!(args.windows(2).any(|pair| pair == ["--cd", "."]));
        assert!(args.windows(2).any(|pair| pair == ["--image", "/tmp/shot.png"]));
        let stdin = stdin_payload(&codex, std::slice::from_ref(&image_path));
        assert!(stdin.contains("Attached images:"));
        assert!(stdin.contains("/tmp/shot.png"));

        let mut cursor = request(HeroiProvider::Cursor);
        cursor.images = vec![png_attachment()];
        let args = build_args(&cursor, std::slice::from_ref(&image_path));
        assert!(!args.iter().any(|arg| arg == "--image"));
        assert!(args.windows(2).any(|pair| pair == ["--workspace", "."]));
        let stdin = stdin_payload(&cursor, std::slice::from_ref(&image_path));
        assert!(stdin.contains("Attached images:"));
        assert!(stdin.contains("/tmp/shot.png"));
    }

    #[test]
    fn cursor_image_files_stage_inside_the_repo() {
        let root = std::env::temp_dir().join(format!("strand-heroi-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".git")).unwrap();
        let mut input = request(HeroiProvider::Cursor);
        input.path = root.to_string_lossy().into_owned();
        input.images = vec![png_attachment()];
        let images = materialize_images(&input).unwrap();
        let staged = images.paths[0].clone();
        assert!(staged.starts_with(root.join(".git")));
        assert!(staged.exists());
        drop(images);
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_non_image_attachments() {
        let mut input = request(HeroiProvider::Claude);
        input.images = vec![HeroiImageAttachment {
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            data_base64: BASE64.encode(b"hello"),
        }];
        assert_eq!(
            validate_request(&input).unwrap_err(),
            "Heroi can only attach PNG, JPEG, GIF, or WebP images."
        );
    }

    #[test]
    fn vendor_transcripts_are_not_returned_as_errors() {
        let error = friendly_error(
            HeroiProvider::Codex,
            "session id: secret\nrepository: C:\\private\nprivate prompt",
            false,
        );
        assert!(!error.contains("secret"));
        assert!(!error.contains("C:\\private"));
    }

    #[test]
    fn image_cli_rejection_is_explicit() {
        let error = friendly_error(
            HeroiProvider::Cursor,
            "error: unknown option '--image'",
            true,
        );
        assert!(error.contains("does not accept images"));
        assert!(!error.contains("unknown option"));
    }

    #[test]
    fn session_events_use_the_frontend_field_name() {
        let value = serde_json::to_value(HeroiAgentEvent::Session {
            session_id: "session-1".into(),
        })
        .unwrap();
        assert_eq!(value["type"], "session");
        assert_eq!(value["sessionId"], "session-1");
        assert!(value.get("session_id").is_none());
    }
}
