use crate::git;
use serde::{Deserialize, Serialize};
use serde_json::json;

const SERVICE: &str = "git-monitor.github";
fn client_id() -> Result<&'static str, String> {
    option_env!("GITHUB_CLIENT_ID").filter(|s| !s.is_empty()).ok_or_else(||"GitHub OAuth is not configured in this build. Set GITHUB_CLIENT_ID when building the app.".to_string())
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "oauth-token").map_err(|e| e.to_string())
}
fn token() -> Result<String, String> {
    entry()?
        .get_password()
        .map_err(|_| "Connect GitHub first".into())
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("git-monitor/0.1")
        .build()
        .expect("HTTP client")
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    #[serde(alias = "device_code")]
    pub device_code: String,
    #[serde(alias = "user_code")]
    pub user_code: String,
    #[serde(alias = "verification_uri")]
    pub verification_uri: String,
    #[serde(alias = "expires_in")]
    pub expires_in: u64,
    pub interval: u64,
}

pub async fn begin_auth() -> Result<DeviceCode, String> {
    let response = client()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id()?), ("scope", "repo read:user")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub sign-in failed: {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}
pub async fn finish_auth(code: &DeviceCode) -> Result<String, String> {
    let attempts = code.expires_in / code.interval.max(5);
    let mut interval = code.interval.max(5);
    for _ in 0..attempts {
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        let response = client()
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id()?),
                ("device_code", code.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        if let Some(t) = body.get("access_token").and_then(|v| v.as_str()) {
            entry()?.set_password(t).map_err(|e| e.to_string())?;
            return Ok("GitHub connected".into());
        }
        match body.get("error").and_then(|v| v.as_str()).unwrap_or("") {
            "authorization_pending" => {}
            "slow_down" => interval += 5,
            "expired_token" => return Err("GitHub sign-in expired. Start again.".into()),
            "access_denied" => return Err("GitHub sign-in was denied.".into()),
            e => return Err(format!("GitHub sign-in failed: {e}")),
        }
    }
    Err("GitHub sign-in expired. Start again.".into())
}
pub fn disconnect() -> Result<(), String> {
    entry()?.delete_credential().map_err(|e| e.to_string())
}
pub fn connected() -> bool {
    token().is_ok()
}

fn github_repo(path: &str) -> Result<(String, String), String> {
    let remote = git::git(path, &["remote", "get-url", "origin"])?;
    let suffix = if let Some(s) = remote.strip_prefix("git@github.com:") {
        s
    } else if let Some(s) = remote.strip_prefix("ssh://git@github.com/") {
        s
    } else if let Some(s) = remote.strip_prefix("https://github.com/") {
        s
    } else {
        return Err("The origin remote is not a GitHub repository".into());
    };
    let slug = suffix.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = slug.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return Err("Could not read the GitHub repository from origin".into());
    }
    Ok((owner.into(), repo.into()))
}
async fn api(
    method: reqwest::Method,
    url: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut request = client()
        .request(method, url)
        .bearer_auth(token()?)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let _ = entry()?.delete_credential();
        return Err("GitHub authorization expired or was revoked. Connect GitHub again.".into());
    }
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("GitHub request failed")
            .into());
    }
    Ok(value)
}
pub async fn prs(path: &str) -> Result<serde_json::Value, String> {
    let (owner, repo) = github_repo(path)?;
    api(
        reqwest::Method::GET,
        format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=all&per_page=30"),
        None,
    )
    .await
}
pub async fn create_pr(
    path: &str,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("Enter a PR title".into());
    }
    let (owner, repo) = github_repo(path)?;
    let value = api(
        reqwest::Method::POST,
        format!("https://api.github.com/repos/{owner}/{repo}/pulls"),
        Some(json!({"title":title,"head":head,"base":base,"body":body})),
    )
    .await?;
    value
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or("GitHub did not return a PR link".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    pub scenario: String,
    pub files: Vec<String>,
    pub commits: Vec<String>,
    pub conflict_files: Vec<String>,
    pub warning: String,
}
pub fn preview_transfer(path: &str, target: &str) -> Result<TransferPreview, String> {
    let r = git::repo(path)?;
    if r.branch != target {
        return Err("Switch to the target branch before starting this workflow".into());
    }
    git::git(path, &["fetch", "origin", target])?;
    let upstream = format!("origin/{target}");
    git::git(path, &["rev-parse", "--verify", &upstream])?;
    let ahead: usize = git::git(path, &["rev-list", "--count", &format!("{upstream}..HEAD")])?
        .parse()
        .map_err(|_| "Could not count local commits")?;
    let behind: usize = git::git(path, &["rev-list", "--count", &format!("HEAD..{upstream}")])?
        .parse()
        .map_err(|_| "Could not count remote commits")?;
    if behind > 0 {
        return Err("Fetch and update the target branch before creating this PR".into());
    }
    if ahead > 0 && !r.files.is_empty() {
        return Err("This branch has both local commits and uncommitted changes. Finish one set of work first so the PR scope is unambiguous.".into());
    }
    if ahead == 0 && r.files.is_empty() {
        return Err("There are no changes to move into a PR".into());
    }
    let scenario = if ahead > 0 {
        "local_commits"
    } else {
        "uncommitted"
    };
    let commits = if ahead > 0 {
        git::git(path, &["log", "--oneline", &format!("{upstream}..HEAD")])?
            .lines()
            .map(str::to_string)
            .collect()
    } else {
        vec![]
    };
    let conflict_files = if ahead > 0 {
        merge_conflicts(path, &upstream, "HEAD")?
    } else {
        vec![]
    };
    Ok(TransferPreview { scenario:scenario.into(), files:r.files.into_iter().map(|f|f.path).collect(), commits, conflict_files,
        warning:if scenario=="local_commits" {"Local target-branch history can be restored only after the new branch is pushed and the PR is created, with your explicit confirmation."} else {"The working changes will stay on the new branch until committed. The original branch can then be revisited safely."}.into() })
}
pub fn merge_conflicts(path: &str, base: &str, head: &str) -> Result<Vec<String>, String> {
    let output = git::git_allow_diff(path, &["merge-tree", "--write-tree", base, head])?;
    let mut files = Vec::new();
    for line in output.lines() {
        if line.starts_with("CONFLICT (") {
            if let Some((_, file)) = line.rsplit_once(" in ") {
                files.push(file.to_string());
            }
        }
    }
    Ok(files)
}
pub async fn transfer(
    path: &str,
    target: &str,
    branch: &str,
    message: &str,
    body: &str,
    confirm_rewrite: bool,
) -> Result<String, String> {
    let preview = preview_transfer(path, target)?;
    if message.trim().is_empty() {
        return Err("Enter a commit message and PR title".into());
    }
    git::git(path, &["check-ref-format", "--branch", branch])?;
    if git::git(
        path,
        &["show-ref", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_ok()
    {
        return Err("That local branch already exists".into());
    }
    git::git(path, &["switch", "-c", branch])?;
    if preview.scenario == "uncommitted" {
        git::stage(path, &[], true, true)?;
        if let Err(e) = git::git(path, &["commit", "-m", message]) {
            return Err(format!(
                "New branch {branch} preserves your changes; commit failed: {e}"
            ));
        }
    }
    if let Err(e) = git::git(path, &["push", "-u", "origin", branch]) {
        return Err(format!(
            "Changes are preserved on local branch {branch}; push failed: {e}"
        ));
    }
    let title = if message.trim().is_empty() {
        format!("Changes from {branch}")
    } else {
        message.into()
    };
    let link = match create_pr(path, branch, target, &title, body).await {
        Ok(url) => url,
        Err(e) => {
            return Err(format!(
                "Branch {branch} is pushed. Pull request creation failed: {e}"
            ))
        }
    };
    if preview.scenario == "local_commits" && confirm_rewrite {
        // The published branch and PR are durable checkpoints before moving the local target ref.
        let upstream = format!("origin/{target}");
        if let Err(e) = git::git(path, &["branch", "-f", target, &upstream]) {
            return Err(format!(
                "PR created: {link}. Local {target} was not restored: {e}"
            ));
        }
    }
    if let Err(e) = git::git(path, &["switch", target]) {
        return Err(format!("PR created: {link}. The feature branch remains checked out because switching back failed: {e}"));
    }
    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };
    #[test]
    fn transfer_preview_distinguishes_dirty_files_from_local_commits() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("git-monitor-transfer-{stamp}"));
        let remote = root.join("remote.git");
        let work = root.join("work");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&work).unwrap();
        let remote = remote.to_string_lossy().to_string();
        let work = work.to_string_lossy().to_string();
        git::git(&remote, &["init", "--bare", "-q"]).unwrap();
        git::git(&work, &["init", "-q"]).unwrap();
        git::git(&work, &["config", "user.name", "Test"]).unwrap();
        git::git(&work, &["config", "user.email", "test@example.invalid"]).unwrap();
        fs::write(Path::new(&work).join("file.txt"), "one\n").unwrap();
        git::git(&work, &["add", "-A"]).unwrap();
        git::git(&work, &["commit", "-qm", "initial"]).unwrap();
        git::git(&work, &["branch", "-M", "main"]).unwrap();
        git::git(&work, &["remote", "add", "origin", &remote]).unwrap();
        git::git(&work, &["push", "-u", "origin", "main"]).unwrap();
        fs::write(Path::new(&work).join("file.txt"), "two\n").unwrap();
        let dirty = preview_transfer(&work, "main").unwrap();
        assert_eq!(dirty.scenario, "uncommitted");
        assert_eq!(dirty.files, vec!["file.txt"]);
        git::git(&work, &["add", "-A"]).unwrap();
        git::git(&work, &["commit", "-qm", "local"]).unwrap();
        let committed = preview_transfer(&work, "main").unwrap();
        assert_eq!(committed.scenario, "local_commits");
        assert_eq!(committed.commits.len(), 1);
        assert_eq!(git::repo(&work).unwrap().branch, "main");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn github_device_payload_accepts_github_field_names() {
        let raw = r#"{"device_code":"a","user_code":"B","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;
        let code: DeviceCode = serde_json::from_str(raw).unwrap();
        assert_eq!(code.user_code, "B");
    }
}
