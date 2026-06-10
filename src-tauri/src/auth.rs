// Google PKCE login flow, auth commands, and central_request proxy.
//
// Secrets layout (all in Keychain under service "ooo.workflow.portuni"):
//   google_refresh_token   – Google OAuth refresh token for id_token renewal
//   portuni_session_jwt    – JWT issued by the Portuni central server
//
// Tauri commands registered here:
//   auth_status            – configured / logged_in / user payload
//   google_login           – full PKCE flow (browser + loopback callback)
//   auth_refresh           – refresh_token → new id_token → /auth/login
//   auth_logout            – delete both keychain entries
//   central_request        – authenticated proxy to server_url (mirrors api_request shape)

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use log::{info, warn};
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::Duration,
};
use tauri::{AppHandle, Manager};

// ─── Keychain accounts ───────────────────────────────────────────────────────

const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
const KEYCHAIN_GOOGLE_REFRESH: &str = "google_refresh_token";
const KEYCHAIN_SESSION_JWT: &str = "portuni_session_jwt";

pub fn keychain_get(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty())
}

fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn keychain_delete(account: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!("keychain delete {account} failed: {e}"),
        }
    }
}

// ─── Config helpers ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AuthConfig {
    pub server_url: String,
    pub google_client_id: String,
}

pub fn load_auth_config(app: &AppHandle) -> Option<AuthConfig> {
    use crate::load_config;
    let data_dir = app.path().app_data_dir().ok()?;
    let config = load_config(&data_dir);
    let server_url = config.server_url?.trim().to_string();
    let google_client_id = config.google_client_id?.trim().to_string();
    if server_url.is_empty() || google_client_id.is_empty() {
        return None;
    }
    Some(AuthConfig {
        server_url,
        google_client_id,
    })
}

// ─── JWT payload decode (display-only, no signature verification) ─────────────

fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let parts: Vec<&str> = jwt.splitn(3, '.').collect();
    if parts.len() < 2 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ─── PKCE helpers ────────────────────────────────────────────────────────────

/// Generate a 32-byte random verifier and encode it as base64url (no padding).
pub fn pkce_verifier() -> String {
    let bytes: Vec<u8> = rand::rngs::OsRng
        .sample_iter(&rand::distributions::Standard)
        .take(32)
        .collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// S256 challenge: base64url( SHA-256( ASCII(verifier) ) )
pub fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    URL_SAFE_NO_PAD.encode(hash)
}

/// Generate 16-byte random state parameter, base64url-encoded.
fn random_state() -> String {
    let bytes: Vec<u8> = rand::rngs::OsRng
        .sample_iter(&rand::distributions::Standard)
        .take(16)
        .collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

// ─── Google token exchange ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GoogleTokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
    // access_token exists but we don't use it
}

async fn exchange_code(
    client: &Client,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<GoogleTokenResponse, String> {
    let params = [
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
    ];
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Google token exchange failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Google token endpoint returned {status}: {body}"
        ));
    }
    res.json::<GoogleTokenResponse>()
        .await
        .map_err(|e| format!("Google token parse failed: {e}"))
}

async fn refresh_google_token(
    client: &Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<String, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Google refresh failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Google refresh returned {status}: {body}"));
    }
    let parsed: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Google refresh parse failed: {e}"))?;
    parsed["id_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Google refresh response missing id_token".to_string())
}

// ─── Central server login ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CentralLoginResponse {
    token: String,
    user: Value,
}

async fn central_login(
    client: &Client,
    server_url: &str,
    id_token: &str,
) -> Result<CentralLoginResponse, String> {
    let url = format!("{}/auth/login", server_url.trim_end_matches('/'));
    let body = serde_json::json!({ "id_token": id_token });
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Central login request failed: {e}"))?;
    let status = res.status().as_u16();
    if status == 401 {
        return Err("Central server rejected the Google token (401)".to_string());
    }
    if status == 404 {
        return Err(
            "Central server is not yet configured for Google login (404). \
             Enable google auth mode and set PORTUNI_GOOGLE_CLIENT_IDS."
                .to_string(),
        );
    }
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Central login returned {status}: {body}"));
    }
    res.json::<CentralLoginResponse>()
        .await
        .map_err(|e| format!("Central login parse failed: {e}"))
}

// ─── Loopback callback listener ───────────────────────────────────────────────

/// Parse the `code` and `state` query params from the first line of an HTTP GET request.
fn parse_callback(line: &str) -> Option<(String, String)> {
    // line: "GET /callback?code=XXX&state=YYY HTTP/1.1"
    let path = line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    let mut code = None;
    let mut state = None;
    for kv in query.split('&') {
        if let Some(v) = kv.strip_prefix("code=") {
            code = Some(url_decode(v));
        } else if let Some(v) = kv.strip_prefix("state=") {
            state = Some(url_decode(v));
        }
    }
    Some((code?, state?))
}

/// Percent-encode a string for use as a URI component value.
/// Encodes everything except unreserved chars (A-Z a-z 0-9 - _ . ~).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

/// Minimal percent-decode (only + and %XX forms we expect from OAuth).
fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(h) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(h as char);
                i += 3;
                continue;
            }
            out.push('%');
            i += 1;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn send_html_response(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

const SUCCESS_HTML: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Portuni</title>\
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;\
min-height:100vh;margin:0;background:#0a0f1e;color:#e0e6f0;}</style></head>\
<body><p>Přihlášení dokončeno, vraťte se do aplikace.</p></body></html>";

const ERROR_HTML: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Portuni</title>\
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;\
min-height:100vh;margin:0;background:#0a0f1e;color:#e0e6f0;}</style></head>\
<body><p>Přihlášení selhalo.</p></body></html>";

/// Spin up a loopback TCP listener, return (port, receiver).
/// The receiver yields Result<(code, state), error_string> exactly once,
/// then the background thread exits. The caller should use recv_timeout
/// on the returned receiver to enforce the overall deadline.
fn start_loopback() -> Result<(u16, mpsc::Receiver<Result<(String, String), String>>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    // accept() blocks until the browser connects. The caller's 120 s recv_timeout
    // returns control to the UI. The background thread lingers until the next
    // connection or app exit. On timeout, the caller connects to the port itself
    // to unblock accept() and let the thread exit cleanly.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        match listener.accept() {
            Err(e) => {
                let _ = tx.send(Err(format!("loopback accept error: {e}")));
            }
            Ok((mut stream, _)) => {
                let reader = BufReader::new(stream.try_clone().expect("stream clone"));
                let first_line = reader.lines().next().and_then(|r| r.ok());
                match first_line.and_then(|l| parse_callback(&l)) {
                    Some((code, state)) => {
                        send_html_response(&mut stream, SUCCESS_HTML);
                        let _ = tx.send(Ok((code, state)));
                    }
                    None => {
                        send_html_response(&mut stream, ERROR_HTML);
                        let _ = tx.send(Err("callback did not contain code/state".to_string()));
                    }
                }
            }
        }
    });
    Ok((port, rx))
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AuthStatus {
    configured: bool,
    logged_in: bool,
    user: Option<Value>,
}

/// Return auth status: whether the desktop is configured for central auth,
/// whether a session JWT is present, and the decoded user claims (display-only).
#[tauri::command]
pub fn auth_status(app: AppHandle) -> AuthStatus {
    let config = load_auth_config(&app);
    let configured = config.is_some();
    let jwt = keychain_get(KEYCHAIN_SESSION_JWT);
    let logged_in = jwt.is_some();
    let user = jwt.as_deref().and_then(decode_jwt_payload);
    AuthStatus {
        configured,
        logged_in,
        user,
    }
}

/// Run Google PKCE login flow:
/// 1. Generate verifier/challenge/state.
/// 2. Bind loopback listener on ephemeral port.
/// 3. Open system browser to authorization URL.
/// 4. Wait up to 120 s for the callback.
/// 5. Exchange auth code for tokens at Google.
/// 6. POST id_token to central server /auth/login.
/// 7. Store refresh_token + session JWT in Keychain.
/// 8. Return user JSON from server response.
#[tauri::command]
pub async fn google_login(app: AppHandle) -> Result<Value, String> {
    let config = load_auth_config(&app)
        .ok_or_else(|| "server_url and google_client_id must be set in config.json".to_string())?;

    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state_param = random_state();

    let (port, rx) = start_loopback()?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
        ?response_type=code\
        &client_id={client_id}\
        &redirect_uri={redirect_uri_enc}\
        &scope=openid%20email%20profile\
        &access_type=offline\
        &prompt=consent\
        &code_challenge={challenge}\
        &code_challenge_method=S256\
        &state={state_param}",
        client_id = config.google_client_id,
        redirect_uri_enc = percent_encode(&redirect_uri),
        challenge = challenge,
        state_param = state_param,
    );

    info!("google_login: opening browser for OAuth");
    open::that(&auth_url).map_err(|e| format!("failed to open browser: {e}"))?;

    // Wait up to 120 s for the browser callback. Use recv_timeout so the
    // async executor isn't held and the user gets a clear timeout message.
    let timeout = Duration::from_secs(120);
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(timeout)
            .unwrap_or_else(|_| Err("login timed out waiting for browser callback (120 s)".to_string()))
    })
    .await
    .map_err(|e| format!("thread join failed: {e}"))?;

    // If timeout, connect to the listener to unblock the background accept() thread.
    if result.is_err() {
        let _ = TcpStream::connect(format!("127.0.0.1:{port}").as_str());
    }

    let (code, returned_state) = result?;

    if returned_state != state_param {
        return Err("CSRF: state parameter mismatch".to_string());
    }

    let client = Client::new();
    let google_tokens = exchange_code(&client, &config.google_client_id, &redirect_uri, &code, &verifier).await?;

    let id_token = google_tokens
        .id_token
        .ok_or_else(|| "Google token exchange did not return id_token".to_string())?;

    // Store refresh_token if present (offline access).
    if let Some(refresh) = google_tokens.refresh_token {
        keychain_set(KEYCHAIN_GOOGLE_REFRESH, &refresh)?;
        info!("google_login: refresh_token stored in Keychain");
    }

    let central = central_login(&client, &config.server_url, &id_token).await?;
    keychain_set(KEYCHAIN_SESSION_JWT, &central.token)?;
    info!("google_login: session JWT stored in Keychain");

    Ok(central.user)
}

/// Refresh the session using the stored Google refresh token.
/// Returns the updated user JSON from the central server.
#[tauri::command]
pub async fn auth_refresh(app: AppHandle) -> Result<Value, String> {
    let config = load_auth_config(&app)
        .ok_or_else(|| "server_url and google_client_id must be set in config.json".to_string())?;

    let refresh_token = keychain_get(KEYCHAIN_GOOGLE_REFRESH)
        .ok_or_else(|| "not logged in: no refresh token in Keychain".to_string())?;

    let client = Client::new();
    let id_token = refresh_google_token(&client, &config.google_client_id, &refresh_token).await?;

    let central = central_login(&client, &config.server_url, &id_token).await?;
    keychain_set(KEYCHAIN_SESSION_JWT, &central.token)?;
    info!("auth_refresh: session JWT refreshed in Keychain");

    Ok(central.user)
}

/// Delete both Keychain entries. Idempotent.
#[tauri::command]
pub fn auth_logout() {
    keychain_delete(KEYCHAIN_GOOGLE_REFRESH);
    keychain_delete(KEYCHAIN_SESSION_JWT);
    info!("auth_logout: Keychain entries removed");
}

// ─── central_request ─────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CentralResponse {
    status: u16,
    body: String,
}

/// Proxy a request to the central server with the session JWT.
/// On 401: attempt one silent refresh and retry.
/// Returns the response shape matching api_request for webview compatibility.
#[tauri::command]
pub async fn central_request(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<CentralResponse, String> {
    let config = load_auth_config(&app)
        .ok_or_else(|| "server_url is not configured".to_string())?;

    let jwt = keychain_get(KEYCHAIN_SESSION_JWT)
        .ok_or_else(|| "not logged in: no session JWT in Keychain".to_string())?;

    let resp = do_central_request(&config.server_url, &method, &path, body.as_ref(), &jwt).await?;

    if resp.status == 401 {
        // Try silent refresh once.
        info!("central_request: got 401, attempting silent refresh");
        match auth_refresh(app).await {
            Err(e) => {
                warn!("central_request: silent refresh failed: {e}");
                // Return the original 401 so the frontend can decide what to do.
                return Ok(resp);
            }
            Ok(_) => {
                let new_jwt = keychain_get(KEYCHAIN_SESSION_JWT)
                    .ok_or_else(|| "not logged in after refresh".to_string())?;
                return do_central_request(&config.server_url, &method, &path, body.as_ref(), &new_jwt).await;
            }
        }
    }

    Ok(resp)
}

async fn do_central_request(
    server_url: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    jwt: &str,
) -> Result<CentralResponse, String> {
    let url = format!(
        "{}/{}",
        server_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let method_parsed =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let client = Client::new();
    let mut req = client
        .request(method_parsed, &url)
        .header("Authorization", format!("Bearer {jwt}"));
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body_text = res.text().await.map_err(|e| e.to_string())?;
    Ok(CentralResponse {
        status,
        body: body_text,
    })
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 Appendix B test vector.
    /// verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    /// expected challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    #[test]
    fn pkce_rfc7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(pkce_challenge(verifier), expected);
    }

    #[test]
    fn url_decode_basics() {
        assert_eq!(url_decode("hello%20world"), "hello world");
        assert_eq!(url_decode("a+b"), "a b");
        assert_eq!(url_decode("no_encoding"), "no_encoding");
    }

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let line = "GET /callback?code=abc123&state=xyz HTTP/1.1";
        let result = parse_callback(line);
        assert!(result.is_some());
        let (code, state) = result.unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
    }
}
