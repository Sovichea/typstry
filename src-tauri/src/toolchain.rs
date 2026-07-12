use semver::Version;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const TINYMIST_RELEASES_URL: &str = "https://api.github.com/repos/Myriad-Dreamin/tinymist/releases";
const TINYMIST_TAGS_URL: &str = "https://api.github.com/repos/Myriad-Dreamin/tinymist/tags";

#[derive(Deserialize)]
struct GithubTag {
    name: String,
}

#[derive(Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Clone)]
struct StableRelease {
    version: Version,
    assets: Vec<GithubAsset>,
}

#[derive(Clone)]
struct InstalledToolchain {
    directory: String,
    tinymist_version: Version,
    typst_version: Version,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectToolchainState {
    ExactActive,
    ExactInstalled,
    DownloadRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TinymistReleaseInfo {
    version: String,
    published_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub typst_version: Option<String>,
    pub typst_source: Option<String>,
    pub tinymist_version: Option<String>,
    pub tinymist_source: Option<String>,
    pub lsp_available: bool,
    pub message: String,
}

fn version_dir(data_dir: &Path, version: &str) -> PathBuf {
    data_dir.join("toolchain").join(version)
}

pub fn managed_executable_path(data_dir: &Path, version: &str, name: &str) -> PathBuf {
    #[cfg(windows)]
    let file_name = format!("{}.exe", name);
    #[cfg(not(windows))]
    let file_name = name.to_string();
    version_dir(data_dir, version).join(file_name)
}

fn command_for(executable: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn version_output(executable: &Path) -> Option<String> {
    let output = command_for(executable).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn labeled_version(text: &str, label: &str) -> Option<Version> {
    text.lines().find_map(|line| {
        let value = line
            .trim()
            .strip_prefix(label)?
            .trim()
            .trim_start_matches('v');
        Version::parse(value).ok()
    })
}

fn tinymist_metadata(executable: &Path) -> Option<(Version, Version)> {
    let text = version_output(executable)?;
    let tinymist = labeled_version(&text, "Build Git Describe:")
        .or_else(|| labeled_version(&text, "Tinymist Version:"))
        .or_else(|| {
            text.lines().find_map(|line| {
                let value = line
                    .trim()
                    .strip_prefix("tinymist")?
                    .trim()
                    .trim_start_matches('v');
                Version::parse(value).ok()
            })
        })
        .or_else(|| {
            let dir_name = executable.parent()?.file_name()?;
            Version::parse(&dir_name.to_string_lossy()).ok()
        })?;
    let typst = labeled_version(&text, "Typst Version:")?;
    Some((tinymist, typst))
}

fn installed_toolchains(data_dir: &Path) -> Vec<InstalledToolchain> {
    let Ok(entries) = std::fs::read_dir(data_dir.join("toolchain")) else {
        return Vec::new();
    };
    let mut installed: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let directory = entry.file_name().to_string_lossy().to_string();
            let executable = managed_executable_path(data_dir, &directory, "tinymist");
            let (tinymist_version, typst_version) = tinymist_metadata(&executable)?;
            Some(InstalledToolchain {
                directory,
                tinymist_version,
                typst_version,
            })
        })
        .collect();
    installed.sort_by(|left, right| right.tinymist_version.cmp(&left.tinymist_version));
    installed
}

pub fn active_version(data_dir: &Path) -> Option<String> {
    active_toolchain(data_dir).map(|toolchain| toolchain.directory)
}

pub fn project_toolchain_state(
    data_dir: &Path,
    required_tinymist: &str,
    required_typst: &str,
) -> ProjectToolchainState {
    let required_tinymist = Version::parse(required_tinymist).ok();
    let required_typst = Version::parse(required_typst).ok();
    let installed = installed_toolchains(data_dir);
    let active = active_toolchain(data_dir);
    classify_project_toolchain(
        active.as_ref(),
        &installed,
        required_tinymist.as_ref(),
        required_typst.as_ref(),
    )
}

fn classify_project_toolchain(
    active: Option<&InstalledToolchain>,
    installed: &[InstalledToolchain],
    required_tinymist: Option<&Version>,
    required_typst: Option<&Version>,
) -> ProjectToolchainState {
    let matches = |toolchain: &InstalledToolchain| {
        required_tinymist == Some(&toolchain.tinymist_version)
            && required_typst == Some(&toolchain.typst_version)
    };
    if active.is_some_and(matches) {
        return ProjectToolchainState::ExactActive;
    }
    if installed.iter().any(matches) {
        ProjectToolchainState::ExactInstalled
    } else {
        ProjectToolchainState::DownloadRequired
    }
}

pub fn select_project_toolchain(
    data_dir: &Path,
    required_tinymist: &str,
    required_typst: &str,
) -> Result<ToolchainStatus, String> {
    let required_tinymist = Version::parse(required_tinymist)
        .map_err(|_| format!("Invalid Tinymist version: {required_tinymist}"))?;
    let required_typst = Version::parse(required_typst)
        .map_err(|_| format!("Invalid Typst version: {required_typst}"))?;
    let installed = installed_toolchains(data_dir)
        .into_iter()
        .find(|toolchain| {
            toolchain.tinymist_version == required_tinymist
                && toolchain.typst_version == required_typst
        })
        .ok_or_else(|| {
            format!(
                "Tinymist {required_tinymist} with embedded Typst {required_typst} is not installed."
            )
        })?;
    let active_file = data_dir.join("toolchain").join("active-version");
    if let Some(parent) = active_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create toolchain directory: {error}"))?;
    }
    std::fs::write(&active_file, &installed.directory).map_err(|error| {
        format!(
            "Failed to select Tinymist {}: {error}",
            installed.tinymist_version
        )
    })?;
    Ok(status(data_dir))
}

fn active_toolchain(data_dir: &Path) -> Option<InstalledToolchain> {
    let installed = installed_toolchains(data_dir);
    let selected = std::fs::read_to_string(data_dir.join("toolchain").join("active-version"))
        .ok()
        .map(|value| value.trim().to_string());
    selected
        .and_then(|directory| {
            installed
                .iter()
                .find(|toolchain| toolchain.directory == directory)
                .cloned()
        })
        .or_else(|| installed.into_iter().next())
}

pub fn resolve_executable(data_dir: &Path, version: &str, name: &str) -> Option<PathBuf> {
    let path = managed_executable_path(data_dir, version, name);
    path.is_file().then_some(path)
}

pub fn active_tinymist(data_dir: &Path) -> Option<PathBuf> {
    let directory = active_version(data_dir)?;
    resolve_executable(data_dir, &directory, "tinymist")
}

pub fn status(data_dir: &Path) -> ToolchainStatus {
    let Some(toolchain) = active_toolchain(data_dir) else {
        return ToolchainStatus {
            typst_version: None,
            typst_source: None,
            tinymist_version: None,
            tinymist_source: None,
            lsp_available: false,
            message: "Tinymist is not installed.".to_string(),
        };
    };
    let tinymist = toolchain.tinymist_version.to_string();
    let typst = toolchain.typst_version.to_string();
    ToolchainStatus {
        typst_version: Some(typst.clone()),
        typst_source: Some(format!("Embedded in Tinymist {}", tinymist)),
        tinymist_version: Some(tinymist.clone()),
        tinymist_source: Some("Managed by Typstella".to_string()),
        lsp_available: true,
        message: format!(
            "Tinymist {} with embedded Typst {} is ready.",
            tinymist, typst
        ),
    }
}

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("Typstella/{}", env!("CARGO_PKG_VERSION")))
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::ACCEPT,
                reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
            );
            headers.insert(
                "x-github-api-version",
                reqwest::header::HeaderValue::from_static("2022-11-28"),
            );
            headers
        })
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to initialize GitHub client: {}", error))
}

fn github_asset_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("Typstella/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|error| format!("Failed to initialize toolchain downloader: {}", error))
}

async fn decode_github_json<T: DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, String> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read {} response: {}", context, error))?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body);
        return Err(format!(
            "{} request failed ({}): {}",
            context,
            status,
            detail.chars().take(240).collect::<String>()
        ));
    }
    serde_json::from_slice(&body).map_err(|error| {
        format!(
            "Failed to decode {} response ({}; {} bytes): {}",
            context,
            content_type,
            body.len(),
            error
        )
    })
}

async fn fetch_stable_versions() -> Result<Vec<Version>, String> {
    let client = github_client()?;
    let mut versions = Vec::new();
    for page in 1.. {
        let response = client
            .get(TINYMIST_TAGS_URL)
            .query(&[("per_page", 100), ("page", page)])
            .send()
            .await
            .map_err(|error| format!("Failed to fetch Tinymist tags: {}", error))?;
        let page_tags: Vec<GithubTag> = decode_github_json(response, "Tinymist tags").await?;
        let is_last_page = page_tags.len() < 100;
        versions.extend(page_tags.into_iter().filter_map(|tag| {
            let version = Version::parse(tag.name.trim_start_matches('v')).ok()?;
            (version.pre.is_empty() && version.patch % 2 == 0).then_some(version)
        }));
        if is_last_page {
            break;
        }
    }
    versions.sort_by(|left, right| right.cmp(left));
    versions.dedup();
    Ok(versions)
}

async fn fetch_release(version: &Version) -> Result<StableRelease, String> {
    let client = github_client()?;
    let response = client
        .get(format!("{}/tags/v{}", TINYMIST_RELEASES_URL, version))
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Tinymist {}: {}", version, error))?;
    let release: GithubRelease =
        decode_github_json(response, &format!("Tinymist {} release", version)).await?;
    stable_release(release).ok_or_else(|| format!("Tinymist {} is not a stable release.", version))
}

fn stable_release(release: GithubRelease) -> Option<StableRelease> {
    if release.draft || release.prerelease {
        return None;
    }
    let version = Version::parse(release.tag_name.trim_start_matches('v')).ok()?;
    if !version.pre.is_empty() || version.patch % 2 == 1 {
        return None;
    }
    Some(StableRelease {
        version,
        assets: release.assets,
    })
}

pub async fn tinymist_releases() -> Result<Vec<TinymistReleaseInfo>, String> {
    Ok(fetch_stable_versions()
        .await?
        .into_iter()
        .map(|version| TinymistReleaseInfo {
            version: version.to_string(),
            published_at: None,
        })
        .collect())
}

fn platform_asset_name() -> Result<String, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("tinymist-win32-x64.exe".into()),
        ("windows", "aarch64") => Ok("tinymist-win32-arm64.exe".into()),
        ("macos", "x86_64") => Ok("tinymist-darwin-x64".into()),
        ("macos", "aarch64") => Ok("tinymist-darwin-arm64".into()),
        ("linux", "x86_64") => Ok("tinymist-linux-x64".into()),
        ("linux", "aarch64") => Ok("tinymist-linux-arm64".into()),
        (os, arch) => Err(format!(
            "No Tinymist binary is published for {} {}.",
            os, arch
        )),
    }
}

async fn download(asset: &GithubAsset) -> Result<Vec<u8>, String> {
    github_asset_client()?
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("Failed to download {}: {}", asset.name, error))?
        .error_for_status()
        .map_err(|error| format!("Download failed for {}: {}", asset.name, error))?
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Failed to read {}: {}", asset.name, error))
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .map_err(|error| format!("Failed to inspect downloaded executable: {}", error))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to mark executable as runnable: {}", error))?;
    }
    Ok(())
}

fn install_managed_executable(data_dir: &Path, version: &str, source: &Path) -> Result<(), String> {
    let destination = managed_executable_path(data_dir, version, "tinymist");
    let directory = destination.parent().ok_or("Invalid toolchain directory")?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create toolchain directory: {}", error))?;
    let staged = directory.join(".tinymist.new");
    let backup = directory.join(".tinymist.old");
    let _ = std::fs::remove_file(&staged);
    let _ = std::fs::remove_file(&backup);
    std::fs::copy(source, &staged)
        .map_err(|error| format!("Failed to stage Tinymist: {}", error))?;
    make_executable(&staged)?;
    if destination.exists() {
        std::fs::rename(&destination, &backup)
            .map_err(|error| format!("Failed to replace existing Tinymist: {}", error))?;
    }
    if let Err(error) = std::fs::rename(&staged, &destination) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &destination);
        }
        return Err(format!("Failed to activate Tinymist: {}", error));
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

pub async fn install(data_dir: &Path, requested_version: &str) -> Result<ToolchainStatus, String> {
    let requested = Version::parse(requested_version.trim_start_matches('v'))
        .map_err(|_| format!("Invalid stable Tinymist version: {}", requested_version))?;
    if !requested.pre.is_empty() || requested.patch % 2 == 1 {
        return Err(
            "Release candidates, prereleases, and Tinymist nightly builds are not supported."
                .to_string(),
        );
    }
    let release = fetch_release(&requested).await?;
    let asset_name = platform_asset_name()?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| format!("Tinymist {} has no {} asset.", release.version, asset_name))?;
    let version = requested.to_string();
    let destination = managed_executable_path(data_dir, &version, "tinymist");
    let already_installed =
        tinymist_metadata(&destination).is_some_and(|(tinymist, _)| tinymist == requested);
    if !already_installed {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| format!("Failed to create app data directory: {}", error))?;
        let bytes = download(asset).await?;
        let temporary = tempfile::NamedTempFile::new_in(data_dir)
            .map_err(|error| format!("Failed to stage Tinymist: {}", error))?;
        std::fs::write(temporary.path(), bytes)
            .map_err(|error| format!("Failed to stage Tinymist: {}", error))?;
        install_managed_executable(data_dir, &version, temporary.path())?;
    }
    let (installed, _) = tinymist_metadata(&destination)
        .ok_or_else(|| "Downloaded Tinymist executable could not be started or did not report its embedded Typst version.".to_string())?;
    if installed != requested {
        return Err(format!(
            "Downloaded Tinymist reported version {}, expected {}.",
            installed, requested
        ));
    }
    std::fs::write(data_dir.join("toolchain").join("active-version"), &version)
        .map_err(|error| format!("Failed to select Tinymist {}: {}", version, error))?;
    Ok(status(data_dir))
}

pub async fn ensure(data_dir: &Path) -> Result<ToolchainStatus, String> {
    let current = status(data_dir);
    if current.lsp_available {
        return Ok(current);
    }
    let latest = fetch_stable_versions()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "GitHub returned no stable Tinymist releases.".to_string())?;
    install(data_dir, &latest.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerelease_and_nightly_versions_are_not_stable() {
        let release = |tag: &str, prerelease| GithubRelease {
            tag_name: tag.to_string(),
            draft: false,
            prerelease,
            assets: vec![],
        };
        assert!(stable_release(release("v0.15.2", false)).is_some());
        assert!(stable_release(release("v0.15.1", false)).is_none());
        assert!(stable_release(release("v0.15.2-rc.1", false)).is_none());
        assert!(stable_release(release("v0.15.2", true)).is_none());
    }

    #[test]
    fn project_toolchain_matching_distinguishes_active_installed_and_missing() {
        let required_tinymist = Version::parse("0.13.10").unwrap();
        let required_typst = Version::parse("0.13.1").unwrap();
        let compatible = InstalledToolchain {
            directory: "0.13.10".to_string(),
            tinymist_version: required_tinymist.clone(),
            typst_version: required_typst.clone(),
        };
        let other = InstalledToolchain {
            directory: "0.14.0".to_string(),
            tinymist_version: Version::parse("0.14.0").unwrap(),
            typst_version: Version::parse("0.13.0").unwrap(),
        };
        assert!(matches!(
            classify_project_toolchain(
                Some(&compatible),
                &[compatible.clone()],
                Some(&required_tinymist),
                Some(&required_typst)
            ),
            ProjectToolchainState::ExactActive
        ));
        assert!(matches!(
            classify_project_toolchain(
                Some(&other),
                &[other.clone(), compatible],
                Some(&required_tinymist),
                Some(&required_typst)
            ),
            ProjectToolchainState::ExactInstalled
        ));
        assert!(matches!(
            classify_project_toolchain(
                Some(&other),
                &[other.clone()],
                Some(&required_tinymist),
                Some(&required_typst)
            ),
            ProjectToolchainState::DownloadRequired
        ));
    }

    #[test]
    fn parses_tinymist_and_embedded_typst_versions() {
        let output = "tinymist\nBuild Git Describe: v0.14.20\nTypst Version: 0.14.2\n";
        assert_eq!(
            labeled_version(output, "Build Git Describe:").unwrap(),
            Version::new(0, 14, 20)
        );
        assert_eq!(
            labeled_version(output, "Typst Version:").unwrap(),
            Version::new(0, 14, 2)
        );
    }

    #[test]
    fn platform_asset_is_supported_for_current_host() {
        assert!(platform_asset_name().is_ok());
    }
}
