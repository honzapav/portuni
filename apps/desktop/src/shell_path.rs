// The PATH a login shell would give the sidecar.
//
// The PATH a GUI-launched app inherits on macOS is launchd's bare
// `/usr/bin:/bin:/usr/sbin:/sbin` -- nothing from /etc/zprofile or
// ~/.zprofile, so `~/.local/bin` (the native Claude Code installer's
// target) and Homebrew are invisible to the sidecar. The runner's `claude`
// detection and the SDK subprocess run from the sidecar's own env, so they
// need the same PATH a login shell would see. Resolved once per process (a
// login shell is ~100 ms), falling back to the inherited PATH when the
// shell cannot answer.
pub(crate) fn login_shell_path() -> String {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let shell = pick_shell();
        match login_shell_path_via(&shell) {
            Some(path) => merge_paths(&path, &inherited),
            None => inherited,
        }
    })
    .clone()
}

const PATH_MARKER: &str = "__PORTUNI_PATH__";

fn login_shell_path_via(shell: &str) -> Option<String> {
    let script = format!("printf '\n{PATH_MARKER}%s{PATH_MARKER}\n' \"$PATH\"");
    let output = std::process::Command::new(shell)
        .args(["-l", "-c", &script])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    parse_marked_path(&String::from_utf8_lossy(&output.stdout))
}

// Pure: extracts the PATH between the two markers, ignoring whatever else a
// profile printed around it.
fn parse_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_MARKER)? + PATH_MARKER.len();
    let rest = &stdout[start..];
    let end = rest.find(PATH_MARKER)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

// Pure: the login shell's PATH first, then any inherited entry it lacks,
// so nothing the host process could already reach is lost.
fn merge_paths(primary: &str, inherited: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for entry in primary.split(':').chain(inherited.split(':')) {
        if !entry.is_empty() && !seen.contains(&entry) {
            seen.push(entry);
        }
    }
    seen.join(":")
}

// The user's $SHELL, so the probe runs the same profile files their own
// terminal does. Falls back to /bin/zsh on macOS (default since 10.15) and
// /bin/bash elsewhere when SHELL is unset or blank.
fn pick_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
}

#[cfg(test)]
mod login_shell_path_tests {
    use super::{merge_paths, parse_marked_path, PATH_MARKER};

    #[test]
    fn parses_the_path_between_markers_ignoring_profile_noise() {
        let stdout =
            format!("motd banner\n{PATH_MARKER}/opt/homebrew/bin:/usr/bin{PATH_MARKER}\ntrailing");
        assert_eq!(
            parse_marked_path(&stdout).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn missing_or_empty_markers_yield_none() {
        assert_eq!(parse_marked_path("no markers here"), None);
        assert_eq!(
            parse_marked_path(&format!("{PATH_MARKER}{PATH_MARKER}")),
            None
        );
    }

    #[test]
    fn merge_keeps_login_order_and_appends_inherited_extras_once() {
        let merged = merge_paths(
            "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin",
            "/usr/bin:/bin:/usr/sbin",
        );
        assert_eq!(
            merged,
            "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin"
        );
    }
}
