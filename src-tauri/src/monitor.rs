use notify::EventKind;
use std::path::{Component, Path};

pub fn is_change(kind: EventKind) -> bool {
    // Opening/reading files during an inspection is not a repository change.
    !matches!(kind, EventKind::Access(_))
}

pub fn is_git_noise(path: &Path) -> bool {
    let mut components = path.components();
    while let Some(component) = components.next() {
        if component == Component::Normal(".git".as_ref()) {
            return matches!(components.next(), Some(Component::Normal(name))
                if name == "objects" || name == "index.lock");
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, ModifyKind};

    #[test]
    fn ignores_reads_and_temporary_git_writes_but_keeps_real_changes() {
        assert!(!is_change(EventKind::Access(AccessKind::Read)));
        assert!(is_change(EventKind::Modify(ModifyKind::Any)));
        for path in [
            "repo/.git/index.lock",
            "repo/.git/objects",
            "repo/.git/objects/ab/cd",
        ] {
            assert!(is_git_noise(Path::new(path)), "{path}");
        }
        for path in [
            "repo/.git/index",
            "repo/.git/HEAD",
            "repo/.git/refs/heads/main",
            "repo/.gitignore",
            "repo/src/main.rs",
            "repo/objects/file",
        ] {
            assert!(!is_git_noise(Path::new(path)), "{path}");
        }
        #[cfg(windows)]
        {
            assert!(is_git_noise(Path::new(r"C:\repo\.git\index.lock")));
            assert!(is_git_noise(Path::new(r"C:\repo\.git\objects\ab\cd")));
            assert!(!is_git_noise(Path::new(r"C:\repo\.git\index")));
        }
    }
}
