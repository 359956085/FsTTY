#!/usr/bin/env python3
"""从已公开的 GitHub Release 同步 FsTTY 官方镜像。"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPOSITORY = "359956085/FsTTY"
API_URL = "https://api.github.com/repos/359956085/FsTTY/releases/latest"
PUBLIC_BASE = "https://f.qkw.io/fstty"
TAG_PATTERN = re.compile(r"v(\d+)\.(\d+)\.(\d+)\Z")
DIGEST_PATTERN = re.compile(r"sha256:([0-9a-f]{64})\Z")
PLATFORMS = {"windows-x86_64", "windows-x86_64-nsis"}
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SIGNATURE_BYTES = 64 * 1024
MAX_INSTALLER_BYTES = 256 * 1024 * 1024


class MirrorError(Exception):
    pass


class HttpsRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if urlsplit(new_url).scheme != "https":
            raise MirrorError("下载重定向未使用 HTTPS")
        return super().redirect_request(request, fp, code, message, headers, new_url)


class HttpTransport:
    def __init__(self):
        self.opener = build_opener(HttpsRedirectHandler())

    def _open(self, url, accept):
        if urlsplit(url).scheme != "https":
            raise MirrorError("下载地址未使用 HTTPS")
        request = Request(url, headers={
            "Accept": accept,
            "User-Agent": "FsTTY-official-mirror/1",
        })
        try:
            response = self.opener.open(request, timeout=90)
        except (HTTPError, URLError, TimeoutError) as error:
            raise MirrorError("GitHub 请求失败：{}".format(error)) from error
        if urlsplit(response.geturl()).scheme != "https":
            response.close()
            raise MirrorError("下载响应未使用 HTTPS")
        return response

    def fetch(self, url, max_bytes):
        with self._open(url, "application/vnd.github+json") as response:
            data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise MirrorError("GitHub 响应超过大小上限")
        return data

    def download(self, url, target, max_bytes):
        digest = hashlib.sha256()
        size = 0
        with self._open(url, "application/octet-stream") as response, target.open("xb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise MirrorError("Release 附件超过大小上限")
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        return size, digest.hexdigest()


def version_numbers(tag):
    match = TAG_PATTERN.fullmatch(tag)
    if not match:
        raise MirrorError("Release 标签不是 vX.Y.Z")
    return tuple(int(part) for part in match.groups())


def expected_asset_url(tag, name):
    return "https://github.com/{}/releases/download/{}/{}".format(
        REPOSITORY, quote(tag, safe=""), quote(name, safe=""),
    )


def release_assets(release):
    if (not isinstance(release, dict) or release.get("draft") is not False
            or release.get("prerelease") is not False):
        raise MirrorError("GitHub 未返回正式 Release")
    tag = release.get("tag_name")
    if not isinstance(tag, str):
        raise MirrorError("Release 缺少标签")
    version_numbers(tag)
    version = tag[1:]
    installer = "FsTTY_{}_x64-setup.exe".format(version)
    limits = {
        installer: MAX_INSTALLER_BYTES,
        installer + ".sig": MAX_SIGNATURE_BYTES,
        "latest.json": MAX_MANIFEST_BYTES,
    }
    entries = release.get("assets")
    if not isinstance(entries, list):
        raise MirrorError("Release 缺少附件列表")
    assets = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("name") not in limits:
            continue
        name = entry["name"]
        if name in assets or entry.get("state") != "uploaded":
            raise MirrorError("Release 附件重复或未上传完成：{}".format(name))
        digest = entry.get("digest")
        size = entry.get("size")
        if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
            raise MirrorError("Release 附件缺少 SHA-256：{}".format(name))
        if type(size) is not int or not 0 < size <= limits[name]:
            raise MirrorError("Release 附件大小无效：{}".format(name))
        url = entry.get("browser_download_url")
        if url != expected_asset_url(tag, name):
            raise MirrorError("Release 附件地址无效：{}".format(name))
        assets[name] = {"url": url, "size": size, "digest": digest[7:], "limit": limits[name]}
    if set(assets) != set(limits):
        raise MirrorError("Release 缺少安装包、签名或更新元数据")
    return tag, version, installer, assets


def validate_manifest(raw, tag, version, installer, signature):
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MirrorError("latest.json 无法解析") from error
    if not isinstance(manifest, dict) or manifest.get("version") != version:
        raise MirrorError("latest.json 版本与 Release 不一致")
    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict) or set(platforms) != PLATFORMS:
        raise MirrorError("latest.json 缺少 Windows 平台")
    github_url = expected_asset_url(tag, installer)
    mirror_url = "{}/releases/{}/{}".format(PUBLIC_BASE, tag, installer)
    rewritten = dict(manifest)
    rewritten["platforms"] = {}
    for platform, item in platforms.items():
        if not isinstance(item, dict) or item.get("url") != github_url:
            raise MirrorError("latest.json 安装包地址无效：{}".format(platform))
        if item.get("signature") != signature:
            raise MirrorError("latest.json 签名与 .sig 不一致：{}".format(platform))
        rewritten["platforms"][platform] = dict(item, url=mirror_url)
    return rewritten


def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def atomic_json(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=".latest-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def sync_directory(path):
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_json(path):
    try:
        with path.open("r", encoding="utf-8") as source:
            return json.load(source)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise MirrorError("已有镜像元数据损坏：{}".format(path)) from error


def now_utc():
    return datetime.now(timezone.utc).isoformat()


def record_failure(root, message):
    state_path = root / "state" / "status.json"
    try:
        state = read_json(state_path) or {}
        if not isinstance(state, dict):
            state = {}
        state["lastError"] = message
        state["lastErrorAt"] = now_utc()
        atomic_json(state_path, state)
    except (OSError, MirrorError):
        pass


def sync_once(root, transport=None):
    transport = transport or HttpTransport()
    public = root / "public"
    releases = public / "releases"
    updater = public / "updater" / "latest.json"
    state_path = root / "state" / "status.json"
    staging = root / "staging"
    if any(path.is_symlink() for path in (
            root, public, releases, updater.parent, state_path.parent, staging)):
        raise MirrorError("镜像目录不能是符号链接")
    releases.mkdir(parents=True, exist_ok=True)
    staging.mkdir(parents=True, exist_ok=True)
    try:
        release = json.loads(transport.fetch(API_URL, MAX_MANIFEST_BYTES))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MirrorError("GitHub Release 响应无法解析") from error
    tag, version, installer, assets = release_assets(release)
    current = read_json(updater)
    previous = read_json(state_path) or {}
    if current is not None and not isinstance(current, dict):
        raise MirrorError("已有镜像元数据格式无效")
    if not isinstance(previous, dict):
        raise MirrorError("镜像状态格式无效")
    if current is not None:
        current_version = current.get("version")
        if not isinstance(current_version, str):
            raise MirrorError("已有镜像版本无效")
        current_tag = "v" + current_version
        if version_numbers(tag) < version_numbers(current_tag):
            raise MirrorError("GitHub 最新版本低于已发布镜像，拒绝自动回退")
        expected_digests = {name: asset["digest"] for name, asset in assets.items()}
        if (current_version == version and previous.get("lastSuccessVersion") == version
                and previous.get("assets") not in (None, expected_digests)):
            raise MirrorError("同版本 GitHub 附件摘要已变化")

    release_dir = releases / tag
    if current is not None and current.get("version") == version:
        if release_dir.is_symlink() or not release_dir.is_dir():
            raise MirrorError("已有版本目录类型无效")
        for name, asset in assets.items():
            existing = release_dir / name
            if not existing.is_file() or sha256_file(existing) != (asset["size"], asset["digest"]):
                raise MirrorError("同版本镜像文件与 GitHub 不一致：{}".format(name))
        try:
            signature = (release_dir / (installer + ".sig")).read_text(encoding="utf-8").strip()
        except UnicodeDecodeError as error:
            raise MirrorError("更新签名不是 UTF-8") from error
        expected_manifest = validate_manifest(
            (release_dir / "latest.json").read_bytes(), tag, version, installer, signature,
        )
        if current != expected_manifest:
            raise MirrorError("同版本镜像元数据与 GitHub 不一致")
        atomic_json(state_path, {
            "lastSuccessVersion": version,
            "lastSuccessAt": now_utc(),
            "lastError": None,
            "lastErrorAt": None,
            "assets": {name: asset["digest"] for name, asset in assets.items()},
        })
        return version

    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=str(staging)))
    try:
        for name, asset in assets.items():
            target = stage / name
            size, digest = transport.download(asset["url"], target, asset["limit"])
            if size != asset["size"] or digest != asset["digest"]:
                raise MirrorError("Release 附件摘要不匹配：{}".format(name))
        try:
            signature = (stage / (installer + ".sig")).read_text(encoding="utf-8").strip()
        except UnicodeDecodeError as error:
            raise MirrorError("更新签名不是 UTF-8") from error
        if not signature:
            raise MirrorError("更新签名为空")
        mirrored_manifest = validate_manifest(
            (stage / "latest.json").read_bytes(), tag, version, installer, signature,
        )
        if release_dir.exists() or release_dir.is_symlink():
            if release_dir.is_symlink() or not release_dir.is_dir():
                raise MirrorError("已有版本目录类型无效")
            for name, asset in assets.items():
                existing = release_dir / name
                if not existing.is_file() or sha256_file(existing) != (asset["size"], asset["digest"]):
                    raise MirrorError("同版本镜像文件与 GitHub 不一致：{}".format(name))
        else:
            os.chmod(stage, 0o755)
            os.replace(stage, release_dir)
            sync_directory(releases)
        if current != mirrored_manifest:
            atomic_json(updater, mirrored_manifest, mode=0o644)
        atomic_json(state_path, {
            "lastSuccessVersion": version,
            "lastSuccessAt": now_utc(),
            "lastError": None,
            "lastErrorAt": None,
            "assets": {name: asset["digest"] for name, asset in assets.items()},
        })
        return version
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description="同步 FsTTY 官方更新镜像")
    parser.add_argument("--root", type=Path, default=Path("/srv/fstty-mirror"))
    args = parser.parse_args()
    try:
        version = sync_once(args.root)
    except (MirrorError, OSError) as error:
        record_failure(args.root, str(error))
        print("官方镜像同步失败：{}".format(error), file=sys.stderr)
        return 1
    print("官方镜像已同步：{}".format(version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
