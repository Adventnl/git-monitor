mod git;
mod github;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    repos: Vec<String>,
    sections: Vec<Section>,
    layout: String,
    positions: HashMap<String, [f64; 2]>,
    viewport: [f64; 3],
    grid: bool,
    auto_monitor: bool,
    appearance: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Section {
    id: String,
    name: String,
    paths: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            repos: vec![],
            sections: vec![],
            layout: "horizontal".into(),
            positions: HashMap::new(),
            viewport: [0.0, 0.0, 1.0],
            grid: true,
            auto_monitor: true,
            appearance: "light".into(),
        }
    }
}
struct AppState {
    settings: Mutex<Settings>,
    save_lock: Mutex<()>,
    watchers: Mutex<Vec<RecommendedWatcher>>,
    config_file: PathBuf,
}
fn save(state: &AppState) -> Result<(), String> {
    let _save_guard = state.save_lock.lock().map_err(|e| e.to_string())?;
    let value = state.settings.lock().map_err(|e| e.to_string())?.clone();
    if let Some(parent) = state.config_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = state.config_file.with_extension("tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(tmp, &state.config_file).map_err(|e| e.to_string())
}
fn watch(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.clear();
    if !settings.auto_monitor {
        return Ok(());
    }
    for root in settings.repos {
        let handle = app.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        let s = path.to_string_lossy();
                        if s.contains("/.git/objects/") || s.contains("\\.git\\objects\\") {
                            continue;
                        }
                        let _ = handle.emit("git-changed", s.to_string());
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        if watcher
            .watch(std::path::Path::new(&root), RecursiveMode::Recursive)
            .is_ok()
        {
            watchers.push(watcher);
        }
    }
    Ok(())
}
#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}
#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    mut settings: Settings,
) -> Result<Settings, String> {
    let renew = {
        let mut current = state.settings.lock().map_err(|e| e.to_string())?;
        // Repository tracking is changed only by add_repos/remove_repo. A delayed
        // viewport or preference save must never restore a removed repository.
        settings.repos = current.repos.clone();
        for section in &mut settings.sections {
            section.paths.retain(|path| settings.repos.contains(path));
        }
        settings
            .positions
            .retain(|path, _| settings.repos.contains(path));
        let renew = current.auto_monitor != settings.auto_monitor;
        *current = settings;
        renew
    };
    save(&state)?;
    if renew {
        watch(&app, &state)?;
    }
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn add_repos(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> Result<Settings, String> {
    let validated = paths.iter().map(|path| git::validate_repo_root(path)).collect::<Result<Vec<_>, _>>()?;
    let value = {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        for path in validated {
            if !s.repos.contains(&path) { s.repos.push(path); }
        }
        s.clone()
    };
    save(&state)?;
    watch(&app, &state)?;
    Ok(value)
}
#[tauri::command]
fn remove_repo(app: AppHandle, state: State<AppState>, path: String) -> Result<Settings, String> {
    let value = {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        s.repos.retain(|r| r != &path);
        for section in &mut s.sections { section.paths.retain(|r| r != &path); }
        s.positions.remove(&path);
        s.clone()
    };
    save(&state)?;
    watch(&app, &state)?;
    Ok(value)
}
#[tauri::command]
async fn inspect_repo(path: String) -> Result<git::Repo, String> {
    tauri::async_runtime::spawn_blocking(move || git::repo(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn file_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::diff(&path, &file, staged))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stage_files(
    path: String,
    files: Vec<String>,
    all: bool,
    include_untracked: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::stage(&path, &files, all, include_untracked))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn unstage_files(path: String, files: Vec<String>, all: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::unstage(&path, &files, all))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn commit_repo(
    path: String,
    message: String,
    mode: String,
    include_untracked: bool,
    push: bool,
    amend: bool,
) -> Result<git::OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::commit_push(&path, &message, &mode, include_untracked, push, amend)
    })
    .await
    .map_err(|e| e.to_string())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkRequest {
    paths: Vec<String>,
    action: String,
    message: Option<String>,
    mode: Option<String>,
    include_untracked: Option<bool>,
}
#[tauri::command]
async fn bulk_operation(app: AppHandle, request: BulkRequest) -> Vec<git::OpResult> {
    let mut results = Vec::new();
    let total = request.paths.len();
    for (index, path) in request.paths.iter().enumerate() {
        let p = path.clone();
        let action = request.action.clone();
        let message = request.message.clone().unwrap_or_default();
        let mode = request.mode.clone().unwrap_or_else(|| "all".into());
        let include = request.include_untracked.unwrap_or(true);
        let result = tauri::async_runtime::spawn_blocking(move || match action.as_str() {
            "commit_push" => git::commit_push(&p, &message, &mode, include, true, false),
            "fetch" => simple_op(&p, git::fetch(&p)),
            "pull" => simple_op(&p, git::pull(&p)),
            "push" => {
                let mut r = simple_op(
                    &p,
                    git::git(&p, &["push"]).map(|_| "Pushed existing local commit".into()),
                );
                r.committed = true;
                if r.status == "success" {
                    r.pushed = true;
                }
                r
            }
            _ => simple_op(&p, Err("Unknown operation".into())),
        })
        .await
        .unwrap_or_else(|e| simple_op(path, Err(e.to_string())));
        let _ = app.emit(
            "bulk-progress",
            serde_json::json!({"index":index+1,"total":total,"result":result}),
        );
        results.push(result);
    }
    results
}
fn simple_op(path: &str, value: Result<String, String>) -> git::OpResult {
    match value {
        Ok(detail) => git::OpResult {
            path: path.into(),
            status: if detail.starts_with("Skipped") {
                "skipped"
            } else {
                "success"
            }
            .into(),
            detail,
            committed: false,
            pushed: false,
        },
        Err(detail) => git::OpResult {
            path: path.into(),
            status: "failed".into(),
            detail,
            committed: false,
            pushed: false,
        },
    }
}
#[tauri::command]
async fn fetch_repo(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::fetch(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn pull_repo(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::pull(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_branches(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git::branches(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn manage_branch(
    path: String,
    action: String,
    name: String,
    other: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::branch_action(&path, &action, &name, other.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn repo_history(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git::history(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn history_detail(path: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::commit_detail(&path, &hash))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn git_version() -> Result<String, String> {
    git::git(".", &["--version"])
}
#[tauri::command]
async fn github_begin() -> Result<github::DeviceCode, String> {
    github::begin_auth().await
}
#[tauri::command]
async fn github_finish(code: github::DeviceCode) -> Result<String, String> {
    github::finish_auth(&code).await
}
#[tauri::command]
fn github_connected() -> bool {
    github::connected()
}
#[tauri::command]
fn github_disconnect() -> Result<(), String> {
    github::disconnect()
}
#[tauri::command]
async fn github_prs(path: String) -> Result<serde_json::Value, String> {
    github::prs(&path).await
}
#[tauri::command]
async fn github_create_pr(
    path: String,
    head: String,
    base: String,
    title: String,
    body: String,
) -> Result<String, String> {
    github::create_pr(&path, &head, &base, &title, &body).await
}
#[tauri::command]
async fn transfer_preview(path: String, target: String) -> Result<github::TransferPreview, String> {
    tauri::async_runtime::spawn_blocking(move || github::preview_transfer(&path, &target))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn transfer_pr(
    path: String,
    target: String,
    branch: String,
    message: String,
    body: String,
    confirm_rewrite: bool,
) -> Result<String, String> {
    github::transfer(&path, &target, &branch, &message, &body, confirm_rewrite).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let file = app.path().app_config_dir()?.join("settings.json");
            let saved = fs::read(&file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
            let mut settings: Settings = saved.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            if settings.repos.is_empty() {
                if let Some(roots) = saved.as_ref().and_then(|v| v.get("roots")).and_then(|v| v.as_array()) {
                    let depth = saved.as_ref().and_then(|v| v.get("maxDepth")).and_then(|v| v.as_u64()).unwrap_or(32) as usize;
                    for root in roots.iter().filter_map(|v| v.as_str()) {
                        if let Ok(found) = git::discover(root, depth) {
                            for repo in found {
                                if !settings.repos.contains(&repo.path) { settings.repos.push(repo.path); }
                            }
                        }
                    }
                }
            }
            let state = AppState {
                settings: Mutex::new(settings),
                save_lock: Mutex::new(()),
                watchers: Mutex::new(vec![]),
                config_file: file,
            };
            watch(app.handle(), &state).ok();
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            add_repos,
            remove_repo,
            inspect_repo,
            file_diff,
            stage_files,
            unstage_files,
            commit_repo,
            bulk_operation,
            fetch_repo,
            pull_repo,
            list_branches,
            manage_branch,
            repo_history,
            history_detail,
            git_version,
            github_begin,
            github_finish,
            github_connected,
            github_disconnect,
            github_prs,
            github_create_pr,
            transfer_preview,
            transfer_pr
        ])
        .run(tauri::generate_context!())
        .expect("git-monitor failed to launch");
}
