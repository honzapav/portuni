// The desktop shell's own texts (spec: Desktop): the app menu's Quit item and
// the loopback pages the browser shows after Google sign-in. They come from
// the `desktop` namespace of the shared catalog, embedded at build time.
//
// One language for the whole app: the menu bar is app-wide on macOS, so it
// follows the window that has focus. The web sends its language with
// `set_ui_locale` after boot, after a language change and whenever its
// window gains focus; the menu is rebuilt when the language changes.

use serde_json::Value;
use std::sync::{Mutex, OnceLock};

const EN: &str = include_str!("../../server/shared/i18n/locales/en/desktop.json");
const CS: &str = include_str!("../../server/shared/i18n/locales/cs/desktop.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UiLocale {
    #[default]
    En,
    Cs,
}

impl UiLocale {
    /// "cs-CZ" -> Cs, "en" -> En, "pseudo"/"de" -> None. Primary subtag
    /// only, as in apps/server/shared/i18n/config.ts.
    pub fn parse(tag: &str) -> Option<Self> {
        let primary = tag.trim().to_ascii_lowercase();
        let primary = primary.split(['-', '_']).next().unwrap_or("");
        match primary {
            "en" => Some(UiLocale::En),
            "cs" => Some(UiLocale::Cs),
            _ => None,
        }
    }

    pub fn tag(self) -> &'static str {
        match self {
            UiLocale::En => "en",
            UiLocale::Cs => "cs",
        }
    }
}

/// The app-wide language, managed state.
#[derive(Default)]
pub struct UiLocaleState(pub Mutex<UiLocale>);

impl UiLocaleState {
    pub fn get(&self) -> UiLocale {
        self.0.lock().map(|l| *l).unwrap_or_default()
    }

    /// Store `locale`; true when it differs from the one held before.
    pub fn set(&self, locale: UiLocale) -> bool {
        match self.0.lock() {
            Ok(mut current) => {
                let changed = *current != locale;
                *current = locale;
                changed
            }
            Err(_) => false,
        }
    }
}

fn catalog(locale: UiLocale) -> &'static Value {
    static EN_JSON: OnceLock<Value> = OnceLock::new();
    static CS_JSON: OnceLock<Value> = OnceLock::new();
    let (cell, raw) = match locale {
        UiLocale::En => (&EN_JSON, EN),
        UiLocale::Cs => (&CS_JSON, CS),
    };
    cell.get_or_init(|| serde_json::from_str(raw).unwrap_or(Value::Null))
}

fn lookup(locale: UiLocale, key: &str) -> Option<&'static str> {
    key.split('.')
        .try_fold(catalog(locale), |node, part| node.get(part))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The text for `key` ("menu.quit") in `locale`, falling back to English,
/// then to the key itself.
pub fn text(locale: UiLocale, key: &str) -> String {
    lookup(locale, key)
        .or_else(|| lookup(UiLocale::En, key))
        .unwrap_or(key)
        .to_string()
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The page the loopback listener answers the browser with after the
/// Google redirect: `success` or the failure page, in `locale`.
pub fn login_page(locale: UiLocale, success: bool) -> String {
    let key = if success { "login.success" } else { "login.failure" };
    format!(
        "<!DOCTYPE html><html lang=\"{lang}\"><head><meta charset=\"utf-8\"><title>Portuni</title>\
<style>body{{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;\
min-height:100vh;margin:0;background:#0a0f1e;color:#e0e6f0;}}</style></head>\
<body><p>{message}</p></body></html>",
        lang = locale.tag(),
        message = escape_html(&text(locale, key)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_primary_subtag() {
        assert_eq!(UiLocale::parse("cs"), Some(UiLocale::Cs));
        assert_eq!(UiLocale::parse("cs-CZ"), Some(UiLocale::Cs));
        assert_eq!(UiLocale::parse(" EN_us "), Some(UiLocale::En));
        assert_eq!(UiLocale::parse("pseudo"), None);
        assert_eq!(UiLocale::parse("de"), None);
        assert_eq!(UiLocale::parse(""), None);
    }

    #[test]
    fn quit_item_follows_the_language() {
        assert_eq!(text(UiLocale::En, "menu.quit"), "Quit Portuni");
        let cs = text(UiLocale::Cs, "menu.quit");
        assert!(cs != "menu.quit" && cs != "Quit Portuni", "cs quit item: {cs}");
    }

    #[test]
    fn every_english_key_has_a_czech_text() {
        fn leaves(v: &Value, prefix: String, out: &mut Vec<String>) {
            match v {
                Value::Object(map) => {
                    for (k, child) in map {
                        let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                        leaves(child, key, out);
                    }
                }
                _ => out.push(prefix),
            }
        }
        let mut keys = Vec::new();
        leaves(catalog(UiLocale::En), String::new(), &mut keys);
        assert!(!keys.is_empty());
        for key in keys {
            assert!(lookup(UiLocale::Cs, &key).is_some(), "cs/desktop.json lacks {key}");
        }
    }

    #[test]
    fn unknown_key_falls_back_to_the_key() {
        assert_eq!(text(UiLocale::Cs, "menu.nope"), "menu.nope");
    }

    #[test]
    fn login_pages_follow_the_language() {
        let en_ok = login_page(UiLocale::En, true);
        assert!(en_ok.contains("<html lang=\"en\">"));
        assert!(en_ok.contains(&text(UiLocale::En, "login.success")));
        let cs_fail = login_page(UiLocale::Cs, false);
        assert!(cs_fail.contains("<html lang=\"cs\">"));
        assert!(cs_fail.contains(&text(UiLocale::Cs, "login.failure")));
        assert_ne!(text(UiLocale::En, "login.failure"), text(UiLocale::Cs, "login.failure"));
    }

    #[test]
    fn state_reports_a_change_only_once() {
        let state = UiLocaleState::default();
        assert_eq!(state.get(), UiLocale::En);
        assert!(state.set(UiLocale::Cs));
        assert!(!state.set(UiLocale::Cs));
        assert_eq!(state.get(), UiLocale::Cs);
    }

    #[test]
    fn escapes_markup_in_texts() {
        assert_eq!(escape_html("<b>&\""), "&lt;b&gt;&amp;&quot;");
    }
}
