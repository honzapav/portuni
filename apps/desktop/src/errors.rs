// The error a Tauri command hands the webview (spec: Desktop). The webview
// never shows Rust's text: every failure is a code with params that the web
// renders from the `errors` namespace (apps/web/src/lib/api-error.ts), in the
// window's language. `message` is English and for logs only.
//
// Serialized as `{ "code": ..., "params": { ... }, "message": ... }`; the
// same shape is the payload of the `backend-error` event.
//
// Plumbing that keeps `Result<_, String>` converts both ways: a `String`
// becomes `Failed` (errors:UNKNOWN_DETAIL with the raw text as data), and a
// `CmdError` becomes its English message where a String is expected.

use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CmdError {
    WorkspaceUnknown { id: String },
    WorkspaceDisabled { id: String },
    WorkspaceExists { id: String },
    WorkspaceIdInvalid,
    WorkspaceLast,
    WorkspaceWindowOpen,
    NotWorkspaceWindow { label: String },
    ConfigNotMigrated,
    ConfigMissing,
    ConfigInvalid { detail: String },
    NotLoggedIn,
    LoginNotConfigured,
    LoginTimeout,
    LoginStateMismatch,
    LoginRejected,
    LoginNotEnabled,
    BrowserOpenFailed { detail: String },
    ServerUrlRequired,
    ServerUrlInsecure,
    ServerUrlScheme { url: String },
    ServerUnreachable { detail: String },
    ServerError { status: u16 },
    DesktopConfigUnavailable,
    BackendNotReady,
    SyncAgentDown,
    BackendFailed { detail: String },
    BackendExited { exit_code: Option<i32> },
    PathInvalid,
    PathNotFound { path: String },
    PathOutOfScope,
    NotHtml,
    NotShowtimeDeck,
    NoMirror,
    NoWipDir,
    ShowtimeOutdated { detail: String },
    UnsupportedOs,
    OpenFailed { detail: String },
    McpInstallPartial { detail: String },
    UrlRefused { scheme: String },
    /// A code the central server or the sidecar answered with, passed on
    /// unchanged (the web knows the server's codes).
    Remote {
        code: String,
        params: BTreeMap<String, String>,
        message: String,
    },
    /// A failure without a code of its own (I/O, HTTP, a poisoned lock...):
    /// errors:UNKNOWN_DETAIL, the raw text shown as data.
    Failed(String),
}

impl CmdError {
    pub fn code(&self) -> &str {
        use CmdError::*;
        match self {
            WorkspaceUnknown { .. } => "DESKTOP_WORKSPACE_UNKNOWN",
            WorkspaceDisabled { .. } => "DESKTOP_WORKSPACE_DISABLED",
            WorkspaceExists { .. } => "DESKTOP_WORKSPACE_EXISTS",
            WorkspaceIdInvalid => "DESKTOP_WORKSPACE_ID_INVALID",
            WorkspaceLast => "DESKTOP_WORKSPACE_LAST",
            WorkspaceWindowOpen => "DESKTOP_WORKSPACE_WINDOW_OPEN",
            NotWorkspaceWindow { .. } => "DESKTOP_NOT_WORKSPACE_WINDOW",
            ConfigNotMigrated => "DESKTOP_CONFIG_NOT_MIGRATED",
            ConfigMissing => "DESKTOP_CONFIG_MISSING",
            ConfigInvalid { .. } => "DESKTOP_CONFIG_INVALID",
            NotLoggedIn => "UNAUTHORIZED",
            LoginNotConfigured => "DESKTOP_LOGIN_NOT_CONFIGURED",
            LoginTimeout => "DESKTOP_LOGIN_TIMEOUT",
            LoginStateMismatch => "DESKTOP_LOGIN_STATE_MISMATCH",
            LoginRejected => "DESKTOP_LOGIN_REJECTED",
            LoginNotEnabled => "DESKTOP_LOGIN_NOT_ENABLED",
            BrowserOpenFailed { .. } => "DESKTOP_BROWSER_OPEN_FAILED",
            ServerUrlRequired => "DESKTOP_SERVER_URL_REQUIRED",
            ServerUrlInsecure => "DESKTOP_SERVER_URL_INSECURE",
            ServerUrlScheme { .. } => "DESKTOP_SERVER_URL_SCHEME",
            ServerUnreachable { .. } => "DESKTOP_SERVER_UNREACHABLE",
            ServerError { .. } => "DESKTOP_SERVER_ERROR",
            DesktopConfigUnavailable => "DESKTOP_CONFIG_UNAVAILABLE",
            BackendNotReady => "DESKTOP_BACKEND_NOT_READY",
            SyncAgentDown => "SYNC_AGENT_DOWN",
            BackendFailed { .. } => "DESKTOP_BACKEND_FAILED",
            BackendExited { .. } => "DESKTOP_BACKEND_EXITED",
            PathInvalid => "INVALID_PATH",
            PathNotFound { .. } => "DESKTOP_PATH_NOT_FOUND",
            PathOutOfScope => "DESKTOP_PATH_OUT_OF_SCOPE",
            NotHtml => "DESKTOP_NOT_HTML",
            NotShowtimeDeck => "DESKTOP_NOT_SHOWTIME_DECK",
            NoMirror => "NO_MIRROR",
            NoWipDir => "DESKTOP_NO_WIP_DIR",
            ShowtimeOutdated { .. } => "DESKTOP_SHOWTIME_OUTDATED",
            UnsupportedOs => "DESKTOP_UNSUPPORTED_OS",
            OpenFailed { .. } => "DESKTOP_OPEN_FAILED",
            McpInstallPartial { .. } => "DESKTOP_MCP_INSTALL_PARTIAL",
            UrlRefused { .. } => "DESKTOP_URL_REFUSED",
            Remote { code, .. } => code,
            Failed(_) => "UNKNOWN_DETAIL",
        }
    }

    // The values the catalog message interpolates, by placeholder name.
    pub fn params(&self) -> BTreeMap<String, String> {
        use CmdError::*;
        let one = |k: &str, v: &str| BTreeMap::from([(k.to_string(), v.to_string())]);
        match self {
            WorkspaceUnknown { id } | WorkspaceDisabled { id } | WorkspaceExists { id } => {
                one("id", id)
            }
            ConfigInvalid { detail }
            | BrowserOpenFailed { detail }
            | ServerUnreachable { detail }
            | BackendFailed { detail }
            | OpenFailed { detail }
            | McpInstallPartial { detail }
            | Failed(detail) => one("detail", detail),
            ServerUrlScheme { url } => one("url", url),
            ServerError { status } => one("status", &status.to_string()),
            BackendExited { exit_code } => one(
                "exitCode",
                &exit_code.map_or_else(|| "-".to_string(), |c| c.to_string()),
            ),
            PathNotFound { path } => one("path", path),
            UrlRefused { scheme } => one("scheme", scheme),
            Remote { params, .. } => params.clone(),
            _ => BTreeMap::new(),
        }
    }

    /// A non-2xx answer from the sidecar or the central server: its code and
    /// params when the body is an error body, else ServerError with the
    /// status.
    pub fn from_http_answer(status: u16, body: &str) -> Self {
        let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
        let code = parsed
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(|c| c.as_str());
        let Some(code) = code else {
            return CmdError::ServerError { status };
        };
        let mut params = BTreeMap::new();
        if let Some(obj) = parsed
            .as_ref()
            .and_then(|v| v.get("params"))
            .and_then(|p| p.as_object())
        {
            for (k, v) in obj {
                match v {
                    serde_json::Value::String(s) => {
                        params.insert(k.clone(), s.clone());
                    }
                    serde_json::Value::Number(n) => {
                        params.insert(k.clone(), n.to_string());
                    }
                    _ => {}
                }
            }
        }
        let message = parsed
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|e| e.as_str())
            .unwrap_or(body)
            .to_string();
        CmdError::Remote {
            code: code.to_string(),
            params,
            message: format!("HTTP {status}: {message}"),
        }
    }
}

// English, for logs; never shown in the UI.
impl fmt::Display for CmdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use CmdError::*;
        match self {
            WorkspaceUnknown { id } => write!(f, "unknown workspace '{id}'"),
            WorkspaceDisabled { id } => write!(f, "workspace '{id}' is disabled"),
            WorkspaceExists { id } => write!(f, "workspace '{id}' already exists"),
            WorkspaceIdInvalid => {
                write!(f, "invalid workspace id (use lowercase letters, digits, dashes)")
            }
            WorkspaceLast => write!(f, "cannot delete the last workspace"),
            WorkspaceWindowOpen => write!(f, "close the workspace's window first"),
            NotWorkspaceWindow { label } => {
                write!(f, "window '{label}' is not a workspace window")
            }
            ConfigNotMigrated => write!(f, "config awaiting workspace migration"),
            ConfigMissing => write!(f, "no config.json (fresh install)"),
            ConfigInvalid { detail } => write!(f, "config.json: {detail}"),
            NotLoggedIn => write!(f, "not logged in"),
            LoginNotConfigured => {
                write!(f, "server_url and google_client_id must be set in config.json")
            }
            LoginTimeout => write!(f, "login timed out waiting for browser callback (120 s)"),
            LoginStateMismatch => write!(f, "CSRF: state parameter mismatch"),
            LoginRejected => write!(f, "central server rejected the Google token (401)"),
            LoginNotEnabled => write!(
                f,
                "central server is not configured for Google login (404); enable google \
                 auth mode and set PORTUNI_GOOGLE_CLIENT_IDS"
            ),
            BrowserOpenFailed { detail } => write!(f, "failed to open browser: {detail}"),
            ServerUrlRequired => write!(f, "server URL is required"),
            ServerUrlInsecure => write!(f, "http:// is allowed only for localhost, use https://"),
            ServerUrlScheme { url } => write!(f, "unsupported URL scheme: {url}"),
            ServerUnreachable { detail } => write!(f, "server unreachable: {detail}"),
            ServerError { status } => write!(f, "server answered HTTP {status}"),
            DesktopConfigUnavailable => write!(
                f,
                "server serves no desktop client config (PORTUNI_DESKTOP_GOOGLE_CLIENT_ID/SECRET)"
            ),
            BackendNotReady => write!(f, "backend not ready"),
            SyncAgentDown => write!(f, "sync agent not running"),
            BackendFailed { detail } => write!(f, "backend failed to start: {detail}"),
            BackendExited { exit_code } => {
                write!(f, "sidecar terminated (exit code {exit_code:?})")
            }
            PathInvalid => write!(f, "invalid path"),
            PathNotFound { path } => write!(f, "path does not exist: {path}"),
            PathOutOfScope => write!(f, "path out of workspace scope"),
            NotHtml => write!(f, "only .html/.htm may be opened externally"),
            NotShowtimeDeck => write!(f, "only a .showtime deck may be opened in Showtime"),
            NoMirror => write!(f, "the node has no mirror on this device"),
            NoWipDir => write!(f, "mirror has no wip/ directory"),
            ShowtimeOutdated { detail } => {
                write!(f, "Showtime cannot take a deck from Portuni, update it ({detail})")
            }
            UnsupportedOs => write!(f, "unsupported OS"),
            OpenFailed { detail } => write!(f, "open failed: {detail}"),
            McpInstallPartial { detail } => write!(f, "some workspaces failed: {detail}"),
            UrlRefused { scheme } => write!(f, "refusing to open scheme: {scheme}"),
            Remote { message, .. } => write!(f, "{message}"),
            Failed(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for CmdError {}

impl Serialize for CmdError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CmdError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("params", &self.params())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<String> for CmdError {
    fn from(detail: String) -> Self {
        CmdError::Failed(detail)
    }
}

impl From<&str> for CmdError {
    fn from(detail: &str) -> Self {
        CmdError::Failed(detail.to_string())
    }
}

impl From<CmdError> for String {
    fn from(err: CmdError) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The English errors catalog: every code the desktop sends must have a
    // message there, or the web shows errors:UNKNOWN_DETAIL instead.
    const EN_ERRORS: &str = include_str!("../../server/shared/i18n/locales/en/errors.json");
    const CS_ERRORS: &str = include_str!("../../server/shared/i18n/locales/cs/errors.json");

    fn every_variant() -> Vec<CmdError> {
        use CmdError::*;
        let s = || "x".to_string();
        vec![
            WorkspaceUnknown { id: s() },
            WorkspaceDisabled { id: s() },
            WorkspaceExists { id: s() },
            WorkspaceIdInvalid,
            WorkspaceLast,
            WorkspaceWindowOpen,
            NotWorkspaceWindow { label: s() },
            ConfigNotMigrated,
            ConfigMissing,
            ConfigInvalid { detail: s() },
            NotLoggedIn,
            LoginNotConfigured,
            LoginTimeout,
            LoginStateMismatch,
            LoginRejected,
            LoginNotEnabled,
            BrowserOpenFailed { detail: s() },
            ServerUrlRequired,
            ServerUrlInsecure,
            ServerUrlScheme { url: s() },
            ServerUnreachable { detail: s() },
            ServerError { status: 500 },
            DesktopConfigUnavailable,
            BackendNotReady,
            SyncAgentDown,
            BackendFailed { detail: s() },
            BackendExited { exit_code: Some(1) },
            PathInvalid,
            PathNotFound { path: s() },
            PathOutOfScope,
            NotHtml,
            NotShowtimeDeck,
            NoMirror,
            NoWipDir,
            ShowtimeOutdated { detail: s() },
            UnsupportedOs,
            OpenFailed { detail: s() },
            McpInstallPartial { detail: s() },
            UrlRefused { scheme: s() },
            Failed(s()),
        ]
    }

    fn catalog_has(catalog: &str, code: &str) -> bool {
        let v: serde_json::Value = serde_json::from_str(catalog).expect("errors.json parses");
        v.get(code).and_then(|m| m.as_str()).is_some()
    }

    #[test]
    fn every_code_has_an_english_and_czech_message() {
        for err in every_variant() {
            assert!(catalog_has(EN_ERRORS, err.code()), "en/errors.json lacks {}", err.code());
            assert!(catalog_has(CS_ERRORS, err.code()), "cs/errors.json lacks {}", err.code());
        }
    }

    #[test]
    fn every_param_is_a_placeholder_of_its_message() {
        let en: serde_json::Value = serde_json::from_str(EN_ERRORS).unwrap();
        for err in every_variant() {
            let message = en[err.code()].as_str().unwrap();
            for key in err.params().keys() {
                assert!(
                    message.contains(&format!("{{{{{key}}}}}")),
                    "{} has param {key} its message does not use",
                    err.code()
                );
            }
        }
    }

    #[test]
    fn serializes_as_code_params_message() {
        let err = CmdError::WorkspaceUnknown { id: "acme".into() };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "DESKTOP_WORKSPACE_UNKNOWN");
        assert_eq!(json["params"]["id"], "acme");
        assert_eq!(json["message"], "unknown workspace 'acme'");
    }

    #[test]
    fn a_plain_string_becomes_unknown_detail_with_the_text() {
        let err: CmdError = "disk full".to_string().into();
        assert_eq!(err.code(), "UNKNOWN_DETAIL");
        assert_eq!(err.params().get("detail").map(String::as_str), Some("disk full"));
    }

    #[test]
    fn converts_back_to_its_english_message() {
        let s: String = CmdError::WorkspaceLast.into();
        assert_eq!(s, "cannot delete the last workspace");
    }

    #[test]
    fn exit_code_param_is_text() {
        let p = CmdError::BackendExited { exit_code: Some(3) }.params();
        assert_eq!(p.get("exitCode").map(String::as_str), Some("3"));
        let p = CmdError::BackendExited { exit_code: None }.params();
        assert_eq!(p.get("exitCode").map(String::as_str), Some("-"));
    }

    #[test]
    fn http_answer_with_a_code_passes_it_through() {
        let err = CmdError::from_http_answer(
            409,
            r#"{"error":"thread runs elsewhere","code":"HANDOFF_RUN_ELSEWHERE","params":{"host":"mac","n":2}}"#,
        );
        assert_eq!(err.code(), "HANDOFF_RUN_ELSEWHERE");
        assert_eq!(err.params().get("host").map(String::as_str), Some("mac"));
        assert_eq!(err.params().get("n").map(String::as_str), Some("2"));
    }

    #[test]
    fn http_answer_without_a_code_is_a_server_error() {
        let err = CmdError::from_http_answer(502, "Bad Gateway");
        assert_eq!(err, CmdError::ServerError { status: 502 });
        assert_eq!(err.code(), "DESKTOP_SERVER_ERROR");
    }
}
