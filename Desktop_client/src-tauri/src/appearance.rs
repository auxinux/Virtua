//! Look of the desktop session, so Virtua Desktop matches it.
//!
//! In AuxiNux Shell (and any desktop with xdg-desktop-portal) light/dark, the
//! accent color and high contrast come from the portal's
//! `org.freedesktop.appearance` settings: the Shell publishes them there,
//! including its sunrise/sunset automatic mode, so reading them is enough to
//! follow it. The font, text size and animations are only in the Shell's own
//! configuration (`~/.config/auxinux-shell/config.json` over the packaged
//! defaults).
use super::*;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// Running inside an AuxiNux Shell session.
    pub auxinux_shell: bool,
    /// `None`: the session expresses no preference (the web view's
    /// `prefers-color-scheme` then decides).
    pub dark: Option<bool>,
    /// `#rrggbb`
    pub accent: Option<String>,
    pub high_contrast: bool,
    pub font_family: Option<String>,
    /// 1.0 = normal; AuxiNux Shell's "larger text" setting (1.1 – 2.0).
    pub text_scale: f32,
    pub animations: bool,
}

/// Values of `org.freedesktop.portal.Settings.ReadAll` as printed by gdbus,
/// e.g. `({'org.freedesktop.appearance': {'color-scheme': <uint32 1>,
/// 'accent-color': <(0.93, 0.54, 0.07)>, 'contrast': <uint32 0>}},)`.
pub fn parse_portal(raw: &str) -> (Option<bool>, Option<String>, bool) {
    let after = |key: &str| raw.find(&format!("'{key}'")).map(|i| &raw[i + key.len() + 2..]);
    let uint = |key: &str| -> Option<u32> {
        let rest = after(key)?;
        let rest = &rest[rest.find("uint32")? + 6..];
        rest.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
    };
    // 0 = no preference, 1 = dark, 2 = light.
    let dark = match uint("color-scheme") {
        Some(1) => Some(true),
        Some(2) => Some(false),
        _ => None,
    };
    let accent = after("accent-color").and_then(|rest| {
        let open = rest.find('(')?;
        let close = rest[open..].find(')')? + open;
        let channels: Vec<f64> = rest[open + 1..close]
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        // Out of range (the spec's "unset" value is -1) = no accent.
        (channels.len() == 3 && channels.iter().all(|c| (0.0..=1.0).contains(c))).then(|| {
            format!(
                "#{:02x}{:02x}{:02x}",
                (channels[0] * 255.0).round() as u8,
                (channels[1] * 255.0).round() as u8,
                (channels[2] * 255.0).round() as u8
            )
        })
    });
    (dark, accent, uint("contrast") == Some(1))
}

fn read_json(path: &Path) -> serde_json::Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// `dotted` key of the user config, else of the packaged defaults.
fn shell_value<'a>(user: &'a serde_json::Value, defaults: &'a serde_json::Value, dotted: &str) -> Option<&'a serde_json::Value> {
    let walk = |root: &'a serde_json::Value| dotted.split('.').try_fold(root, |node, key| node.get(key));
    walk(user).or_else(|| walk(defaults))
}

/// Font, text size and animations of AuxiNux Shell (same rules as its
/// palette.py / theme.py).
pub fn shell_preferences(user: &serde_json::Value, defaults: &serde_json::Value) -> (Option<String>, f32, bool) {
    let font = shell_value(user, defaults, "font.family")
        .and_then(|v| v.as_str())
        .map(|f| f.replace(['"', ';', '{', '}'], "").trim().to_string())
        .filter(|f| !f.is_empty());
    let large = shell_value(user, defaults, "accessibility.large_text").and_then(|v| v.as_bool()).unwrap_or(false);
    let percent = shell_value(user, defaults, "accessibility.text_scale").and_then(|v| v.as_u64()).unwrap_or(125);
    let scale = if large { (if percent > 100 { percent.min(200) } else { 125 }) as f32 / 100.0 } else { 1.0 };
    let animations = shell_value(user, defaults, "animations").and_then(|v| v.as_bool()).unwrap_or(true);
    (font, scale, animations)
}

fn in_auxinux_shell() -> bool {
    env::var("XDG_CURRENT_DESKTOP")
        .map(|desktops| desktops.split(':').any(|d| d.eq_ignore_ascii_case("AuxiNux")))
        .unwrap_or(false)
}

pub fn current() -> Appearance {
    let mut appearance = Appearance { text_scale: 1.0, animations: true, ..Default::default() };
    if env::consts::OS != "linux" {
        return appearance;
    }
    appearance.auxinux_shell = in_auxinux_shell();
    let mut command = platform::command("gdbus");
    command.args([
        "call",
        "--session",
        "--dest",
        "org.freedesktop.portal.Desktop",
        "--object-path",
        "/org/freedesktop/portal/desktop",
        "--method",
        "org.freedesktop.portal.Settings.ReadAll",
        "['org.freedesktop.appearance']",
    ]);
    if let Ok(raw) = platform::output(command, Duration::from_secs(3)) {
        let (dark, accent, contrast) = parse_portal(&raw);
        appearance.dark = dark;
        appearance.accent = accent;
        appearance.high_contrast = contrast;
    }
    if appearance.auxinux_shell {
        let defaults = read_json(Path::new("/usr/share/auxinux-shell/config.json"));
        let config_home = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| platform::home().ok().map(|h| h.join(".config")));
        let user = config_home
            .map(|dir| read_json(&dir.join("auxinux-shell/config.json")))
            .unwrap_or(serde_json::Value::Null);
        let (font, scale, animations) = shell_preferences(&user, &defaults);
        appearance.font_family = font;
        appearance.text_scale = scale;
        appearance.animations = animations;
    }
    appearance
}

#[tauri::command]
pub async fn desktop_appearance() -> Appearance {
    tauri::async_runtime::spawn_blocking(current).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_auxinux_shell_portal_values() {
        let raw = "({'org.freedesktop.appearance': {'color-scheme': <uint32 1>, 'accent-color': <(0.93725490196078431, 0.54117647058823526, 0.070588235294117646)>, 'contrast': <uint32 0>}},)";
        assert_eq!(parse_portal(raw), (Some(true), Some("#ef8a12".into()), false));
        let light = "({'org.freedesktop.appearance': {'color-scheme': <uint32 2>, 'contrast': <uint32 1>}},)";
        assert_eq!(parse_portal(light), (Some(false), None, true));
        // GNOME without preference, accent unset (-1).
        let none = "({'org.freedesktop.appearance': {'color-scheme': <uint32 0>, 'accent-color': <(-1.0, -1.0, -1.0)>}},)";
        assert_eq!(parse_portal(none), (None, None, false));
        assert_eq!(parse_portal(""), (None, None, false));
    }

    #[test]
    fn follows_the_shell_font_text_size_and_animations() {
        let defaults = serde_json::json!({"font": {"family": "Inter Variable"}, "animations": true,
            "accessibility": {"large_text": false}});
        assert_eq!(shell_preferences(&serde_json::Value::Null, &defaults), (Some("Inter Variable".into()), 1.0, true));
        let user = serde_json::json!({"font": {"family": "Noto Sans\";}"}, "animations": false,
            "accessibility": {"large_text": true, "text_scale": 150}});
        assert_eq!(shell_preferences(&user, &defaults), (Some("Noto Sans".into()), 1.5, false));
        // "Larger text" on with no explicit size: 125 %, like the Shell.
        let user = serde_json::json!({"accessibility": {"large_text": true}});
        assert_eq!(shell_preferences(&user, &defaults).1, 1.25);
    }
}
