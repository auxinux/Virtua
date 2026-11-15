//! Windows 11 straight from Microsoft, like Parallels' « Get Windows 11 from
//! Microsoft » or WinBoat's engine (dockur/windows, Mido): the same public
//! API as microsoft.com/software-download/windows11, which hands out a
//! temporary link to the official ISO. Nothing is mirrored on our servers
//! (Microsoft allows downloading its ISO, not redistributing it).
//!
//! Requests, in order (the page's own JavaScript does the same):
//! 1. the download page: product edition id (`<option value="3813">Windows…`)
//!    and the SHA-256 table published under « Verify your download »;
//! 2. session registration (vlscppe) and the « OV » challenge (ov-df):
//!    without them Microsoft answers the next calls with an error;
//! 3. `getskuinformationbyproductedition`: one SKU per language;
//! 4. `GetProductDownloadLinksBySku`: the ISO link, `DownloadType` 1 for x64,
//!    2 for ARM64.
//!
//! Checked live on 2026-11-15: product edition 3813 (it changes with each
//! release, hence read from the page and never hardcoded), « French Canadian »
//! and « English » SKUs, Windows11_Client_x64_fr-ca_26300_9457.iso.

use super::http_client;
use serde::Deserialize;
use std::time::Duration;

const PROFILE: &str = "606624d44113";
const ORG_ID: &str = "y6jn8c31";
const OV_INSTANCE: &str = "560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175";
/// Shown when the session steps cannot be reached.
pub const BLOCKED_HINT: &str = "Votre réseau semble bloquer vlscppe.microsoft.com ou ov-df.microsoft.com (bloqueur de publicités, Pi-hole, pare-feu) : Microsoft exige ces deux adresses pour autoriser le téléchargement. Autorisez-les, ou téléchargez l’ISO vous-même.";
/// A browser's: the download API rejects unknown clients.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/// Language offered by the quick create, and what it means for Microsoft's
/// ISO and for Windows Setup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsLanguage {
    /// Français (Canada): Microsoft's « French Canadian » ISO.
    FrCa,
    /// English (Canada): Microsoft has no en-CA ISO; the « English » (en-US)
    /// ISO, set to Canadian formats and keyboard by the answer file.
    EnCa,
}

impl WindowsLanguage {
    pub fn parse(code: Option<&str>) -> Result<Self, String> {
        match code.map(str::trim).filter(|c| !c.is_empty()).unwrap_or("fr-CA").to_ascii_lowercase().as_str() {
            "fr-ca" | "fr" => Ok(Self::FrCa),
            "en-ca" | "en" => Ok(Self::EnCa),
            other => Err(format!("Langue de Windows non prise en charge : {other} (fr-CA ou en-CA)")),
        }
    }

    /// Code stored on the VM and given to the answer file (fr-CA, en-CA).
    pub fn code(self) -> &'static str {
        match self {
            Self::FrCa => "fr-CA",
            Self::EnCa => "en-CA",
        }
    }

    /// `Language` field of Microsoft's SKU list.
    fn sku_language(self) -> &'static str {
        match self {
            Self::FrCa => "French Canadian",
            Self::EnCa => "English",
        }
    }

    /// Row label of the SHA-256 table, before « 64-bit ».
    fn hash_label(self) -> &'static str {
        self.sku_language()
    }

    /// Language tag inside Microsoft's file names (…_fr-ca_…, …_en-us_…).
    #[cfg(test)]
    pub fn iso_tag(self) -> &'static str {
        match self {
            Self::FrCa => "fr-ca",
            Self::EnCa => "en-us",
        }
    }
}

/// The official ISO to download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicrosoftIso {
    pub url: String,
    pub file_name: String,
    /// Lowercase hex, from Microsoft's page; `None` when the page lists none
    /// for this language (the download then goes on unverified).
    pub sha256: Option<String>,
}

pub fn page_url(arch: &str) -> &'static str {
    if arch == "arm64" {
        "https://www.microsoft.com/en-us/software-download/windows11arm64"
    } else {
        "https://www.microsoft.com/en-us/software-download/windows11"
    }
}

/// Page for a manual download, in the user's language.
pub fn manual_page_url(arch: &str, language: WindowsLanguage) -> String {
    let locale = match language {
        WindowsLanguage::FrCa => "fr-ca",
        WindowsLanguage::EnCa => "en-ca",
    };
    format!("https://www.microsoft.com/{locale}/software-download/windows11{}", if arch == "arm64" { "arm64" } else { "" })
}

/// First `<option value="NNNN">Windows…` of the page's edition selector.
pub fn parse_product_edition(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(start) = rest.find("<option") {
        rest = &rest[start + 7..];
        let end = rest.find('>')?;
        let attrs = &rest[..end];
        let text = rest[end + 1..].trim_start();
        if text.starts_with("Windows") {
            if let Some(value) = attr_value(attrs, "value") {
                if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn attr_value(attrs: &str, name: &str) -> Option<String> {
    let at = attrs.find(&format!("{name}="))? + name.len() + 1;
    let quote = attrs[at..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = &attrs[at + 1..];
    Some(value[..value.find(quote)?].to_string())
}

/// SHA-256 of `<label> 64-bit` (or `<label> Arm64` on the ARM page) in the
/// « Verify your download » table: `<td>French Canadian 64-bit</td><td>F32E…</td>`.
pub fn parse_sha256(html: &str, label: &str) -> Option<String> {
    let names = [format!("{label} 64-bit"), format!("{label} Arm64"), format!("{label} ARM64")];
    names.iter().find_map(|name| {
        let cell = format!("<td>{name}</td>");
        let at = html.find(&cell)? + cell.len();
        let rest = html[at..].trim_start();
        let rest = rest.strip_prefix("<td>")?;
        let hash: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        (hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

/// `w` token and `rticks` of the OV challenge script.
pub fn parse_ov_challenge(script: &str) -> Option<(String, String)> {
    let token = ["?w=", "&w="].iter().find_map(|key| {
        let at = script.find(key)? + key.len();
        let hex: String = script[at..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        (!hex.is_empty()).then_some(hex)
    })?;
    let at = script.find("rticks=\"")? + 8;
    let ticks: String = script[at..].trim_start_matches('+').chars().take_while(|c| c.is_ascii_digit()).collect();
    (!ticks.is_empty()).then_some((token, ticks))
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SkuList {
    #[serde(default)]
    skus: Vec<Sku>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Sku {
    id: serde_json::Value,
    #[serde(default)]
    language: String,
}

pub fn parse_sku_id(json: &str, language: &str) -> Option<String> {
    let list: SkuList = serde_json::from_str(json).ok()?;
    list.skus.into_iter().find(|sku| sku.language == language).map(|sku| match sku.id {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Links {
    #[serde(default)]
    product_download_options: Vec<DownloadOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DownloadOption {
    #[serde(default)]
    uri: String,
    #[serde(default)]
    download_type: i64,
}

/// ISO link for the architecture, or why there is none.
pub fn parse_download_link(json: &str, arch: &str) -> Result<String, String> {
    if json.contains("Sentinel marked this request as rejected") || json.contains("We are unable to complete your request") {
        return Err("Microsoft a refusé le téléchargement automatique depuis cette connexion.".into());
    }
    let wanted = if arch == "arm64" { 2 } else { 1 };
    let links: Links = serde_json::from_str(json).map_err(|_| "Réponse inattendue du serveur de Microsoft.".to_string())?;
    links
        .product_download_options
        .into_iter()
        .find(|option| option.download_type == wanted && option.uri.starts_with("https://"))
        .map(|option| option.uri)
        .ok_or_else(|| "Microsoft n’a fourni aucun lien de téléchargement.".into())
}

/// Last path segment of the link, without its query string.
pub fn file_name_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?.trim();
    (name.to_ascii_lowercase().ends_with(".iso") && !name.contains("..")).then(|| name.to_string())
}

fn session_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Asks Microsoft for today's official Windows 11 ISO in this language.
pub fn find_iso(arch: &str, language: WindowsLanguage) -> Result<MicrosoftIso, String> {
    let page = page_url(arch);
    let client = http_client(Duration::from_secs(30))?;
    let get = |url: &str| -> Result<String, String> {
        client
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::REFERER, page)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("microsoft.com injoignable : {e}"))
    };
    let html = get(page)?;
    let edition = parse_product_edition(&html).ok_or("Page de téléchargement de Microsoft illisible (édition introuvable).")?;
    let sha256 = parse_sha256(&html, language.hash_label());
    let session = session_id();
    // Both steps are required: without them Microsoft answers « Sentinel
    // marked this request as rejected » (checked 2026-11-15). DNS ad blockers
    // (Pi-hole…) often block them (vlscppe is an alias of online-metrix.net):
    // say so instead of a bare network error. We do not work around a
    // blocker the user chose.
    let blocked = |e: String| format!("{e}\n{}", BLOCKED_HINT);
    get(&format!("https://vlscppe.microsoft.com/tags?org_id={ORG_ID}&session_id={session}")).map_err(blocked)?;
    let script = get(&format!("https://ov-df.microsoft.com/mdt.js?instanceId={OV_INSTANCE}&PageId=si&session_id={session}"))
        .map_err(blocked)?;
    if let Some((token, ticks)) = parse_ov_challenge(&script) {
        std::thread::sleep(Duration::from_millis(200));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        get(&format!(
            "https://ov-df.microsoft.com/?session_id={session}&CustomerId={OV_INSTANCE}&PageId=si&w={token}&mdt={now}&rticks={ticks}"
        ))?;
    }
    let api = "https://www.microsoft.com/software-download-connector/api";
    let skus = get(&format!(
        "{api}/getskuinformationbyproductedition?profile={PROFILE}&ProductEditionId={edition}&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID={session}"
    ))?;
    let sku = parse_sku_id(&skus, language.sku_language())
        .ok_or_else(|| format!("Microsoft ne propose pas Windows 11 en « {} » aujourd’hui.", language.sku_language()))?;
    let links = get(&format!(
        "{api}/GetProductDownloadLinksBySku?profile={PROFILE}&ProductEditionId=undefined&SKU={sku}&friendlyFileName=undefined&Locale=en-US&sessionID={session}"
    ))?;
    let url = parse_download_link(&links, arch).map_err(|e| if e.contains("refusé") { format!("{e}\n{BLOCKED_HINT}") } else { e })?;
    let file_name = file_name_from_url(&url).ok_or("Lien de Microsoft sans nom d’ISO.")?;
    Ok(MicrosoftIso { url, file_name, sha256 })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<select id="product-edition"><option value="" selected>Select Download</option>
<option value="3813">Windows 11 (multi-edition ISO for x64 devices)</option></select>
<table><tr><td>Finnish 64-bit</td><td>32B9D11B13E1A200ED7C08D2E495C4B57C6B38150C8DFC679C5E80BC7A5F8767</td></tr>
<tr><td>French Canadian 64-bit</td><td>F32E5538EE3F73206294378109501C9E2E2DA78DCDE66C43F4610B18CEEBC0A7</td></tr>
<tr><td>French 64-bit</td><td>AA515279F02FB2B425EFF341F0A1F158D61288C72CCA5F9D87B79B5A23F7F918</td></tr>
<tr><td>English International 64-bit</td><td>7E3F373BD3C2321B5D5125DFCF718DFBF1A0ABC50A267118669951890DF98A5D</td></tr>
<tr><td>English 64-bit</td><td>BD4307DF32BC8AF33B39CCECB1174AEB345386630F89A2B86C7A4E36B55EA650</td></tr></table>"#;

    #[test]
    fn reads_the_product_edition_and_the_hashes_of_the_page() {
        assert_eq!(parse_product_edition(PAGE).as_deref(), Some("3813"));
        assert_eq!(
            parse_sha256(PAGE, WindowsLanguage::FrCa.hash_label()).as_deref(),
            Some("f32e5538ee3f73206294378109501c9e2e2da78dcde66c43f4610b18ceebc0a7")
        );
        // « English » must not match « English International ».
        assert_eq!(
            parse_sha256(PAGE, WindowsLanguage::EnCa.hash_label()).as_deref(),
            Some("bd4307df32bc8af33b39ccecb1174aeb345386630f89a2b86c7a4e36b55ea650")
        );
        assert_eq!(parse_sha256(PAGE, "Klingon"), None);
        assert_eq!(parse_product_edition("<option value=\"\">Choisir</option>"), None);
    }

    #[test]
    fn reads_the_ov_challenge() {
        let script = r#"var u="https://ov-df.microsoft.com/?session_id=x&w=A1B2c3&x=1";var t={rticks="+639000123456"};"#;
        assert_eq!(parse_ov_challenge(script), Some(("A1B2c3".into(), "639000123456".into())));
        assert_eq!(parse_ov_challenge("nothing"), None);
    }

    #[test]
    fn picks_the_sku_and_the_link_of_the_architecture() {
        let skus = r#"{"Skus":[{"Id":"27160","Language":"English","LocalizedLanguage":"English (United States)"},
            {"Id":"27128","Language":"English (United Kingdom)"},{"Id":27133,"Language":"French Canadian"}]}"#;
        assert_eq!(parse_sku_id(skus, "French Canadian").as_deref(), Some("27133"));
        assert_eq!(parse_sku_id(skus, "English").as_deref(), Some("27160"));
        assert_eq!(parse_sku_id(skus, "German"), None);
        let links = r#"{"ProductDownloadOptions":[{"Uri":"https://software.download.prss.microsoft.com/dbazure/Windows11_Client_x64_fr-ca_26300_9457.iso?t=abc&e=1","DownloadType":1}]}"#;
        let url = parse_download_link(links, "amd64").unwrap();
        assert_eq!(file_name_from_url(&url).as_deref(), Some("Windows11_Client_x64_fr-ca_26300_9457.iso"));
        assert!(parse_download_link(links, "arm64").is_err());
        assert!(parse_download_link(r#"{"Errors":[{"Value":"Sentinel marked this request as rejected."}]}"#, "amd64")
            .unwrap_err()
            .contains("refusé"));
    }

    #[test]
    fn languages_map_to_microsoft_names_and_setup_codes() {
        assert_eq!(WindowsLanguage::parse(None).unwrap(), WindowsLanguage::FrCa);
        assert_eq!(WindowsLanguage::parse(Some("en-CA")).unwrap().code(), "en-CA");
        assert_eq!(WindowsLanguage::EnCa.iso_tag(), "en-us");
        assert!(WindowsLanguage::parse(Some("de-DE")).is_err());
        assert!(manual_page_url("amd64", WindowsLanguage::FrCa).starts_with("https://www.microsoft.com/fr-ca/"));
        assert!(session_id().len() == 36);
    }

    /// Live check against microsoft.com: `cargo test -- --ignored live_microsoft`.
    #[test]
    #[ignore]
    fn live_microsoft() {
        for language in [WindowsLanguage::FrCa, WindowsLanguage::EnCa] {
            let iso = find_iso("amd64", language).unwrap();
            assert!(iso.file_name.to_ascii_lowercase().contains(language.iso_tag()), "{iso:?}");
            assert!(iso.sha256.is_some(), "{iso:?}");
            eprintln!("{iso:?}");
        }
    }
}
