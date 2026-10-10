use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub kind: String,
    pub files: Vec<FileChange>,
    pub ahead: usize,
    pub behind: usize,
    pub upstream: Option<String>,
    pub remote: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub path: String,
    pub status: String,
    pub detail: String,
    pub committed: bool,
    pub pushed: bool,
}

fn output(path: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git").arg("-C").arg(path).args(args)
        .env("GIT_TERMINAL_PROMPT", "0").output()
        .map_err(|e| format!("Could not run Git: {e}. Install Git or choose its executable in your system settings."))
}
pub fn git(path: &str, args: &[&str]) -> Result<String, String> {
    let out = output(path, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
pub fn git_allow_diff(path: &str, args: &[&str]) -> Result<String, String> {
    let out = output(path, args)?;
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
fn safe_file(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute()
        || p.components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        || path.is_empty()
    {
        return Err("Invalid repository file path".into());
    }
    Ok(())
}
pub fn repo(path: &str) -> Result<Repo, String> {
    git(path, &["rev-parse", "--git-dir"])?;
    let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .or_else(|_| git(path, &["rev-parse", "--short", "HEAD"]).map(|s| format!("detached {s}")))
        .unwrap_or_else(|_| "unborn branch".into());
    let status = output(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
    }
    let mut files = BTreeMap::<String, FileChange>::new();
    let parts: Vec<&[u8]> = status
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .collect();
    let mut i = 0;
    while i < parts.len() {
        let row = parts[i];
        i += 1;
        if row.len() < 4 {
            continue;
        }
        let x = row[0] as char;
        let y = row[1] as char;
        let name = String::from_utf8_lossy(&row[3..]).to_string();
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            i += 1;
        }
        let code = if x == '?' {
            "U"
        } else if x == 'U' || y == 'U' || x == 'A' && y == 'A' || x == 'D' && y == 'D' {
            "C"
        } else if x == 'R' || y == 'R' {
            "R"
        } else if x == 'D' || y == 'D' {
            "D"
        } else if x == 'A' || y == 'A' {
            "A"
        } else {
            "M"
        };
        files.insert(
            name.clone(),
            FileChange {
                path: name,
                status: code.into(),
                staged: x != ' ' && x != '?',
                unstaged: y != ' ' || x == '?',
            },
        );
    }
    let upstream = git(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok();
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            git(
                path,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
            .ok()
        })
        .and_then(|s| {
            let mut n = s.split_whitespace();
            Some((n.next()?.parse().ok()?, n.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));
    let remote = git(path, &["remote", "get-url", "origin"])
        .ok()
        .or_else(|| {
            let first = git(path, &["remote"]).ok()?.lines().next()?.to_string();
            git(path, &["remote", "get-url", &first]).ok()
        });
    let kind = if git(path, &["rev-parse", "--show-superproject-working-tree"])
        .unwrap_or_default()
        .is_empty()
    {
        "repository"
    } else {
        "submodule"
    };
    let name = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.into());
    Ok(Repo {
        path: path.into(),
        name,
        branch,
        kind: kind.into(),
        files: files.into_values().collect(),
        ahead,
        behind,
        upstream,
        remote,
        error: None,
    })
}

pub fn validate_repo_root(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Choose a repository folder".into());
    }
    let root = git(canonical.to_string_lossy().as_ref(), &["rev-parse", "--show-toplevel"])
        .map_err(|_| "This folder is not a Git repository".to_string())?;
    let actual = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if actual != canonical {
        return Err("Choose the repository's top-level folder".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}
pub fn discover(root: &str, max_depth: usize) -> Result<Vec<Repo>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err("Folder no longer exists".into());
    }
    let mut paths = Vec::<PathBuf>::new();
    for entry in walkdir::WalkDir::new(root_path)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".git")
    {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.path().join(".git").exists() {
            paths.push(entry.path().to_path_buf());
        }
    }
    // A bare repository has no working tree and is intentionally excluded from the canvas.
    paths.sort();
    paths.dedup();
    Ok(paths
        .into_iter()
        .map(|p| {
            let s = p.to_string_lossy().to_string();
            repo(&s).unwrap_or_else(|error| Repo {
                path: s.clone(),
                name: p.file_name().unwrap_or_default().to_string_lossy().into(),
                branch: "—".into(),
                kind: "repository".into(),
                files: vec![],
                ahead: 0,
                behind: 0,
                upstream: None,
                remote: None,
                error: Some(error),
            })
        })
        .collect())
}
pub fn diff(path: &str, file: &str, staged: bool) -> Result<String, String> {
    safe_file(file)?;
    let args = if staged {
        vec!["diff", "--cached", "--no-ext-diff", "--", file]
    } else {
        vec!["diff", "--no-ext-diff", "--", file]
    };
    let result = git_allow_diff(path, &args)?;
    if result.is_empty() && !staged && Path::new(path).join(file).is_file() {
        let absolute = Path::new(path).join(file).to_string_lossy().to_string();
        let empty = if cfg!(windows) { "NUL" } else { "/dev/null" };
        git_allow_diff(path, &["diff", "--no-index", "--", empty, &absolute])
    } else {
        Ok(result)
    }
}
pub fn stage(
    path: &str,
    files: &[String],
    all: bool,
    include_untracked: bool,
) -> Result<(), String> {
    if all {
        if include_untracked {
            git(path, &["add", "-A"])?;
        } else {
            git(path, &["add", "-u"])?;
        }
    } else {
        for file in files {
            safe_file(file)?;
            git(path, &["add", "--", file])?;
        }
    }
    Ok(())
}
pub fn unstage(path: &str, files: &[String], all: bool) -> Result<(), String> {
    if all {
        git(path, &["restore", "--staged", ":/"])?;
    } else {
        for file in files {
            safe_file(file)?;
            git(path, &["restore", "--staged", "--", file])?;
        }
    }
    Ok(())
}
pub fn commit_push(
    path: &str,
    message: &str,
    mode: &str,
    include_untracked: bool,
    push: bool,
    amend: bool,
) -> OpResult {
    let mut result = OpResult {
        path: path.into(),
        status: "failed".into(),
        detail: String::new(),
        committed: false,
        pushed: false,
    };
    if message.trim().is_empty() && !amend {
        result.detail = "Enter a commit message".into();
        return result;
    }
    let step = (|| -> Result<(), String> {
        if amend {
            let r = repo(path)?;
            if r.upstream.is_none() || r.ahead == 0 || r.behind > 0 {
                return Err("Amend is available only when the last commit is still local and this branch is ahead of its upstream".into());
            }
        }
        if mode == "all" {
            stage(path, &[], true, include_untracked)?;
        } else if mode == "tracked" {
            stage(path, &[], true, false)?;
        }
        let staged = git(path, &["diff", "--cached", "--name-only"])?;
        if staged.is_empty() {
            return Err("No staged changes to commit".into());
        }
        if amend {
            if message.trim().is_empty() {
                git(path, &["commit", "--amend", "--no-edit"])?;
            } else {
                git(path, &["commit", "--amend", "-m", message.trim()])?;
            }
        } else {
            git(path, &["commit", "-m", message.trim()])?;
        }
        result.committed = true;
        if push {
            git(path, &["push"])?;
            result.pushed = true;
        }
        Ok(())
    })();
    match step {
        Ok(()) => {
            result.status = "success".into();
            result.detail = if push {
                "Committed and pushed"
            } else {
                "Committed locally"
            }
            .into();
        }
        Err(e) => {
            result.detail = if result.committed {
                format!("Commit is local; push failed: {e}")
            } else {
                e
            };
        }
    }
    result
}
pub fn fetch(path: &str) -> Result<String, String> {
    if git(path, &["remote"])?.is_empty() {
        return Ok("Skipped: no remote".into());
    }
    git(path, &["fetch", "--all", "--prune"])?;
    Ok("Fetched".into())
}
pub fn pull(path: &str) -> Result<String, String> {
    let original = repo(path)?;
    if !original.files.is_empty() {
        return Err("Skipped: working tree has changes".into());
    }
    if original.upstream.is_none() {
        return Err("Skipped: no upstream branch".into());
    }
    git(path, &["fetch"])?;
    let r = repo(path)?;
    if !r.files.is_empty() {
        return Err("Skipped: working tree has changes".into());
    }
    if r.upstream.is_none() {
        return Err("Skipped: no upstream branch".into());
    }
    if r.ahead > 0 && r.behind > 0 {
        return Err("Skipped: branches have diverged".into());
    }
    if r.behind == 0 {
        return Ok("Already up to date".into());
    }
    git(path, &["pull", "--ff-only"])?;
    Ok("Fast-forwarded".into())
}
pub fn branches(path: &str) -> Result<Vec<String>, String> {
    Ok(git(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?
    .lines()
    .map(str::to_string)
    .collect())
}
pub fn branch_action(
    path: &str,
    action: &str,
    name: &str,
    other: Option<&str>,
) -> Result<String, String> {
    if name.trim().is_empty() || name.starts_with('-') {
        return Err("Enter a valid branch name".into());
    }
    match action {
        "create" => {
            git(path, &["check-ref-format", "--branch", name])?;
            git(path, &["switch", "-c", name])?;
        }
        "switch" => {
            git(path, &["switch", name])?;
        }
        "rename" => {
            let new_name = other.ok_or("Enter a new branch name")?;
            git(path, &["check-ref-format", "--branch", new_name])?;
            git(path, &["branch", "-m", name, new_name])?;
        }
        "delete" => {
            git(path, &["branch", "-d", name])?;
        }
        "publish" => {
            git(path, &["push", "-u", "origin", name])?;
        }
        _ => return Err("Unknown branch action".into()),
    }
    Ok("Branch updated".into())
}
pub fn history(path: &str) -> Result<Vec<String>, String> {
    Ok(git(
        path,
        &[
            "log",
            "-n",
            "30",
            "--date=short",
            "--pretty=format:%h%x09%ad%x09%s",
        ],
    )?
    .lines()
    .map(str::to_string)
    .collect())
}
pub fn commit_detail(path: &str, hash: &str) -> Result<String, String> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid commit hash".into());
    }
    git(
        path,
        &[
            "show",
            "--format=fuller",
            "--stat",
            "--no-ext-diff",
            "--find-renames",
            hash,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> (PathBuf, String) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("git-monitor-test-{}-{stamp}-{}", std::process::id(), FIXTURE_ID.fetch_add(1, Ordering::Relaxed)));
        let nested = root.join("projects").join("one");
        fs::create_dir_all(&nested).unwrap();
        let p = nested.to_string_lossy().to_string();
        git(&p, &["init", "-q"]).unwrap();
        git(&p, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(&p, &["config", "user.name", "Test"]).unwrap();
        fs::write(nested.join("tracked.txt"), "first\n").unwrap();
        git(&p, &["add", "-A"]).unwrap();
        git(&p, &["commit", "-qm", "first"]).unwrap();
        (root, p)
    }
    #[test]
    fn nested_discovery_and_distinct_status_paths() {
        let (root, p) = fixture();
        let list = discover(root.to_str().unwrap(), 16).unwrap();
        assert_eq!(list.len(), 1);
        fs::write(Path::new(&p).join("tracked.txt"), "second\n").unwrap();
        git(&p, &["add", "tracked.txt"]).unwrap();
        fs::write(Path::new(&p).join("tracked.txt"), "third\n").unwrap();
        fs::write(Path::new(&p).join("new.txt"), "new\n").unwrap();
        let r = repo(&p).unwrap();
        assert_eq!(r.files.len(), 2);
        let tracked = r.files.iter().find(|f| f.path == "tracked.txt").unwrap();
        assert!(tracked.staged && tracked.unstaged);
        assert_eq!(diff(&p, "new.txt", false).unwrap().contains("+new"), true);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selection_requires_the_repository_root() {
        let (root, p) = fixture();
        assert_eq!(validate_repo_root(&p).unwrap(), fs::canonicalize(&p).unwrap().to_string_lossy());
        assert!(validate_repo_root(root.to_str().unwrap()).is_err());
        let child = Path::new(&p).join("child");
        fs::create_dir_all(&child).unwrap();
        assert!(validate_repo_root(child.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pull_never_updates_dirty_worktree() {
        let (root, p) = fixture();
        fs::write(Path::new(&p).join("tracked.txt"), "changed\n").unwrap();
        assert!(pull(&p).unwrap_err().contains("working tree has changes"));
        fs::remove_dir_all(root).unwrap();
    }
}
